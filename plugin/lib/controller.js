'use strict';

const { validateTarget } = require('./monitorian');

const DEFAULTS = Object.freeze({
    target: 'linked',
    step: 5,
    preset: 50,
    applyDelay: 300,
    monitorianPath: ''
});

function normalizeSettings(settings = {}) {
    const out = { ...DEFAULTS };
    // The monitor chooser was removed in v0.3.1: always use basic /get and /set.
    // Keep the target property for controller/cache compatibility with earlier versions.
    const step = Number(settings.step);
    if (Number.isInteger(step) && step >= 1 && step <= 25) out.step = step;
    const preset = Number(settings.preset);
    if (Number.isInteger(preset) && preset >= 0 && preset <= 100) out.preset = preset;
    const applyDelay = Number(settings.applyDelay);
    if (Number.isInteger(applyDelay) && applyDelay >= 100 && applyDelay <= 1000) out.applyDelay = applyDelay;
    if (typeof settings.monitorianPath === 'string') out.monitorianPath = settings.monitorianPath;
    return out;
}

function levelForTarget(rows, target) {
    const selected = target === 'premium-all' ? rows :
        (target === 'linked' || target === 'selected' || target === 'all') ?
        (rows.filter(x => x.selected).length ? rows.filter(x => x.selected) : rows.slice(0, 1)) : rows.filter(x => x.id === target);
    if (!selected.length) return null;
    const levels = [...new Set(selected.map(x => x.brightness))];
    return levels.length === 1 ? levels[0] : 'mixed';
}

const clamp = value => Math.min(100, Math.max(0, value));

// The desired value is stored and published SYNCHRONOUSLY. DDC/CI writes take
// place only after input settles, and at most one write per scope is in flight.
// A slow /set reply must never replace a newer desired value on the display.
class BrightnessController {
    constructor(client, { debounceMs = 300, onChange = () => {}, onError = () => {} } = {}) {
        this.client = client;
        this.debounceMs = debounceMs;
        this.onChange = onChange;
        this.onError = onError;
        this.tail = Promise.resolve();
        this.cache = new Map();
        this.scopes = new Map();
        this.disposed = false;
    }

    cacheKey(path, target) { return JSON.stringify([path, target]); }

    scope(path, target) {
        const key = this.cacheKey(path, target);
        if (!this.scopes.has(key)) {
            this.scopes.set(key, {
                path, target, desired: null, confirmed: null, delta: 0,
                dirty: false, writing: false, reading: null, timer: null,
                revision: 0, waiters: [], error: false, delay: this.debounceMs
            });
        }
        return this.scopes.get(key);
    }

    enqueue(fn) {
        const job = this.tail.catch(() => {}).then(fn);
        this.tail = job.catch(() => {});
        return job;
    }

    display(path = '', target = 'linked') {
        const state = this.scope(path, target);
        if (state.error && !state.dirty && !state.writing) return { title: 'ОШИБ.', value: null, pending: false, error: true };
        const pending = state.dirty || state.writing || state.delta !== 0;
        if (state.desired !== null) return { title: `${state.desired}%`, value: state.desired, pending, error: false };
        if (state.delta !== 0) {
            const sign = state.delta > 0 ? '+' : '';
            return { title: `${sign}${state.delta}%`, value: null, pending: true, error: false };
        }
        if (state.confirmed === 'mixed') return { title: 'РАЗН.', value: null, pending, error: false };
        return { title: '…', value: null, pending, error: false };
    }

    notify(state) { this.onChange(state.path, state.target, this.display(state.path, state.target)); }

    // Cache actual results without allowing a delayed /get or /set to erase the
    // user's latest (still pending) knob/button input.
    record(state, rows) {
        this.cache.set(this.cacheKey(state.path, state.target), { rows, time: Date.now() });
        const actual = levelForTarget(rows, state.target);
        if (actual !== null) state.confirmed = actual;
        if (!state.dirty && !state.writing) state.error = false;
        if (state.desired === null && state.delta !== 0 && typeof actual === 'number') {
            state.desired = clamp(actual + state.delta);
            state.delta = 0;
        } else if (!state.dirty && !state.writing && actual !== null) {
            state.desired = typeof actual === 'number' ? actual : null;
        }
        this.notify(state);
        return rows;
    }

    read(path = '', target = 'linked') {
        validateTarget(target);
        const state = this.scope(path, target);
        if (state.reading) return state.reading;
        // A periodic/manual read while a write is pending would be stale and
        // cause unnecessary DDC traffic. Exception: initial baseline fetch.
        if ((state.dirty || state.writing) && (state.desired !== null || state.confirmed === 'mixed')) {
            return Promise.resolve(this.cache.get(this.cacheKey(path, target))?.rows || []);
        }
        const promise = this.enqueue(async () => {
            const rows = await this.client.read(path, target);
            if (!this.disposed) this.record(state, rows);
            return rows;
        });
        state.reading = promise;
        promise.then(() => {
            if (state.reading === promise) state.reading = null;
            if (state.dirty) this.schedule(state, state.delay);
        }, err => {
            if (state.reading === promise) state.reading = null;
            // Without a baseline it is unsafe to invent an absolute brightness.
            if (state.desired === null && state.dirty && state.confirmed === null) {
                state.dirty = false;
                state.delta = 0;
                state.error = true;
                this.rejectWaiters(state, state.revision, err);
                this.notify(state);
                this.onError(path, target, err);
            } else if (state.dirty && state.desired !== null) {
                // A preset received while /get was in flight must still be sent,
                // even if that preliminary /get failed.
                this.schedule(state, 0);
            }
        });
        return promise;
    }

    schedule(state, delay = this.debounceMs) {
        if (this.disposed) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = null;
            this.flush(state);
        }, delay);
    }

    waitFor(state) {
        const revision = state.revision;
        return new Promise((resolve, reject) => state.waiters.push({ revision, resolve, reject }));
    }

    settleWaiters(state, upTo, error, result) {
        const remaining = [];
        for (const waiter of state.waiters) {
            if (waiter.revision > upTo) remaining.push(waiter);
            else if (error) waiter.reject(error);
            else waiter.resolve(result);
        }
        state.waiters = remaining;
    }

    rejectWaiters(state, upTo, error) { this.settleWaiters(state, upTo, error, null); }

    change(target, amount, path = '', delay = this.debounceMs) {
        validateTarget(target);
        if (!Number.isInteger(amount) || amount === 0 || !Number.isFinite(amount)) return Promise.resolve(null);
        if (this.disposed) return Promise.reject(new Error('Plugin shutting down'));
        const state = this.scope(path, target);
        if (state.desired !== null) state.desired = clamp(state.desired + amount);
        else state.delta = Math.max(-1000, Math.min(1000, state.delta + amount));
        state.revision++;
        state.dirty = true;
        state.error = false;
        state.delay = delay;
        this.notify(state); // IMPORTANT: happens before any Monitorian/IPC await.
        const promise = this.waitFor(state);
        if (state.desired === null && state.confirmed === null) {
            void this.read(path, target).catch(() => {});
        } else this.schedule(state, delay);
        return promise;
    }

    set(target, value, path = '', delay = this.debounceMs) {
        validateTarget(target);
        if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Яркость должна быть от 0 до 100');
        if (this.disposed) return Promise.reject(new Error('Plugin shutting down'));
        const state = this.scope(path, target);
        state.desired = value;
        state.delta = 0;
        state.revision++;
        state.dirty = true;
        state.error = false;
        state.delay = delay;
        this.notify(state);
        const promise = this.waitFor(state);
        this.schedule(state, delay);
        return promise;
    }

    flush(state) {
        if (!state.dirty || this.disposed) return;
        if (state.writing || state.reading) return; // one write at a time
        if (state.desired === null && state.confirmed === null) {
            void this.read(state.path, state.target).catch(() => {});
            return;
        }
        const revision = state.revision;
        const absolute = state.desired;
        const relative = state.delta;
        if (absolute === null && relative === 0) {
            state.dirty = false;
            this.settleWaiters(state, revision, null, this.cache.get(this.cacheKey(state.path, state.target))?.rows || []);
            this.notify(state);
            return;
        }
        state.dirty = false;
        state.writing = true;
        state.delta = 0;
        // Always prefer absolute /set; in mixed premium group only a relative
        // command can preserve each display's individual starting brightness.
        const job = this.enqueue(() => absolute !== null
            ? this.client.set(state.target, absolute, state.path)
            : this.client.change(state.target, relative, state.path));
        job.then(rows => {
            if (!this.disposed) {
                // `record` can update confirmed, but not erase newer requests.
                this.record(state, rows);
                if (!state.dirty && state.revision === revision) {
                    const actual = levelForTarget(rows, state.target);
                    if (actual !== null) state.desired = typeof actual === 'number' ? actual : null;
                }
                this.settleWaiters(state, revision, null, rows);
            }
        }, err => {
            if (!this.disposed) {
                this.rejectWaiters(state, revision, err);
                if (!state.dirty && state.revision === revision) {
                    state.error = true;
                    state.desired = typeof state.confirmed === 'number' ? state.confirmed : null;
                }
                this.onError(state.path, state.target, err);
            }
        }).finally(() => {
            state.writing = false;
            if (this.disposed) return;
            this.notify(state);
            if (state.dirty) this.schedule(state, 0); // only newest requested value
        });
    }

    invalidate() {
        this.cache.clear();
        for (const state of this.scopes.values()) {
            if (state.dirty || state.writing) continue;
            state.desired = null;
            state.confirmed = null;
            state.error = false;
            this.notify(state);
        }
    }

    dispose() {
        this.disposed = true;
        for (const state of this.scopes.values()) {
            if (state.timer) clearTimeout(state.timer);
            this.rejectWaiters(state, Infinity, new Error('Plugin shutting down'));
        }
    }
}

module.exports = { BrightnessController, normalizeSettings, levelForTarget };
