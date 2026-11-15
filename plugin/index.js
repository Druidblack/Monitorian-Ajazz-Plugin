'use strict';

const { LocalWebSocket } = require('./lib/websocket');
const { MonitorianClient } = require('./lib/monitorian');
const { BrightnessController, normalizeSettings } = require('./lib/controller');
const { startPolling } = require('./lib/polling');

const ACTION_PREFIX = 'com.openai.streamdock.monitorian.';
const ACTIONS = {
    'brightness-up': 'up',
    'brightness-down': 'down',
    'brightness-preset': 'preset',
    'brightness-encoder': 'encoder',
    'brightness-status': 'status'
};

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length - 1; i += 2) args[String(argv[i]).replace(/^-+/, '')] = argv[i + 1];
    const port = Number(args.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !args.pluginUUID || !args.registerEvent) {
        throw new Error('Некорректные параметры запуска от Stream Dock AJAZZ');
    }
    return { port, uuid: args.pluginUUID, event: args.registerEvent };
}

function main() {
    const opts = parseArgs(process.argv);
    const ws = new LocalWebSocket(opts.port);
    const active = new Map();
    const client = new MonitorianClient();
    const lastDisplayed = new Map();
    const send = data => { if (ws.open) ws.send(data); };
    // Polls can be frequent, but repeat titles must not flood the AJAZZ LCD.
    const safeTitle = (context, title) => {
        const value = String(title);
        if (lastDisplayed.get(context) === value) return;
        lastDisplayed.set(context, value);
        send({ event: 'setTitle', context, payload: { target: 0, title: value } });
    };
    const controller = new BrightnessController(client, { onChange: (path, target, display) => {
        for (const [context, state] of active) {
            if (state.settings.monitorianPath !== path || state.settings.target !== target) continue;
            safeTitle(context, display.title);
        }
    } });
    let stopPolling = null;
    let lastPress = new Map();
    const lastAlert = new Map();

    function warn(context, error, action) {
        console.error('[Monitorian]', action, error?.stack || error);
        const state = active.get(context);
        if (!state) return;
        const key = controller.cacheKey(state.settings.monitorianPath, state.settings.target);
        if (Date.now() - (lastAlert.get(key) || 0) < 1500) return;
        lastAlert.set(key, Date.now());
        send({ event: 'showAlert', context });
    }

    async function refresh(path = '', target = 'linked') {
        try { await controller.read(path, target); }
        catch (err) {
            console.error('[Monitorian] Cannot refresh:', err.message);
            if (!controller.cache.has(controller.cacheKey(path, target))) {
                for (const [context, state] of active) {
                    if (state.settings.monitorianPath === path && state.settings.target === target) safeTitle(context, 'Н/Д');
                }
            }
        }
    }

    async function updateAll() {
        const scopes = [...new Set([...active.values()].map(v => controller.cacheKey(v.settings.monitorianPath, v.settings.target)))];
        for (const key of scopes) {
            const [path, target] = JSON.parse(key);
            // Let a pending encoder/button write complete first; do not enqueue
            // a stale /get behind it or repeatedly read while input is active.
            const scope = controller.scope(path, target);
            if (scope.dirty || scope.writing || scope.reading) continue;
            await refresh(path, target);
        }
    }

    async function onPress(context) {
        const state = active.get(context);
        if (!state) return;
        const { settings, type } = state;
        try {
            if (type === 'up' || type === 'down') {
                // Update the LCD immediately; don't wait for the DDC/CI request.
                void controller.change(settings.target, settings.step * (type === 'up' ? 1 : -1), settings.monitorianPath, settings.applyDelay)
                    .catch(err => warn(context, err, 'press'));
            } else if (type === 'preset' || type === 'encoder') {
                void controller.set(settings.target, settings.preset, settings.monitorianPath, settings.applyDelay)
                    .catch(err => warn(context, err, 'press'));
            } else if (type === 'status') {
                await controller.read(settings.monitorianPath, settings.target);
            }
        } catch (err) { warn(context, err, 'press'); }
    }

    async function onRotate(context, payload) {
        const state = active.get(context);
        if (state?.type !== 'encoder') return;
        const ticks = Number(payload?.ticks || 0);
        if (!Number.isFinite(ticks) || !Number.isInteger(ticks) || !ticks) return;
        const delta = Math.max(-100, Math.min(100, ticks * state.settings.step));
        try {
            void controller.change(state.settings.target, delta, state.settings.monitorianPath, state.settings.applyDelay)
                .catch(err => warn(context, err, 'rotate'));
        } catch (err) { warn(context, err, 'rotate'); }
    }

    async function handle(msg) {
        const event = msg?.event;
        const context = msg?.context;
        const type = typeof msg.action === 'string' && msg.action.startsWith(ACTION_PREFIX)
            ? ACTIONS[msg.action.slice(ACTION_PREFIX.length)] : null;
        if (event === 'willAppear' && type && context) {
            const settings = normalizeSettings(msg.payload?.settings);
            active.set(context, { type, settings });
            safeTitle(context, '…');
            // Never use stale CLI cache instead of a newer value selected with the encoder.
            safeTitle(context, controller.display(settings.monitorianPath, settings.target).title);
            const cache = controller.cache.get(controller.cacheKey(settings.monitorianPath, settings.target));
            if (!cache || Date.now() - cache.time >= 10000) void refresh(settings.monitorianPath, settings.target);
        } else if (event === 'didReceiveSettings' && context && active.has(context)) {
            const state = active.get(context);
            const previousPath = state.settings.monitorianPath;
            const previousTarget = state.settings.target;
            state.settings = normalizeSettings(msg.payload?.settings);
            safeTitle(context, controller.display(state.settings.monitorianPath, state.settings.target).title);
            if (previousPath !== state.settings.monitorianPath || previousTarget !== state.settings.target) void refresh(state.settings.monitorianPath, state.settings.target);
        } else if (event === 'willDisappear' && context) {
            active.delete(context); lastPress.delete(context); lastDisplayed.delete(context);
        } else if (event === 'keyUp' && type) {
            // Avoid duplicate events from a knob; do not throttle actual keypad presses.
            if (type !== 'encoder' || Date.now() - (lastPress.get(context) || 0) > 250) {
                if (type === 'encoder') lastPress.set(context, Date.now());
                await onPress(context);
            }
        } else if (event === 'dialDown' && type === 'encoder') {
            if (Date.now() - (lastPress.get(context) || 0) > 250) {
                lastPress.set(context, Date.now());
                await onPress(context);
            }
        } else if (event === 'dialRotate' && type === 'encoder') {
            await onRotate(context, msg.payload);
        } else if (event === 'systemDidWakeUp') {
            controller.invalidate();
            await updateAll();
        }
    }

    ws.on('open', () => {
        send({ event: opts.event, uuid: opts.uuid });
        // Refresh external changes made inside the Monitorian GUI promptly.
        // Only one /get cycle can run at a time, even when CLI calls are slow.
        stopPolling = startPolling({
            intervalMs: 1000,
            shouldRun: () => active.size > 0,
            tick: updateAll,
            onError: err => console.error('[Monitorian] Background refresh:', err)
        });
    });
    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            Promise.resolve(handle(msg)).catch(err => console.error('[Monitorian] Event failure:', err));
        } catch (err) { console.error('[Monitorian] Bad host event:', err); }
    });
    ws.on('error', err => console.error('[Monitorian] Stream Dock connection:', err.message));
    ws.on('close', () => { if (stopPolling) stopPolling(); controller.dispose(); process.exitCode = 0; });
}

if (require.main === module) {
    try { main(); } catch (err) { console.error(err); process.exitCode = 1; }
}
module.exports = { parseArgs };
