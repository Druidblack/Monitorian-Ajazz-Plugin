'use strict';

let socket;
let uuid;
let context;
let action;
let settings = { target: 'linked', step: 5, preset: 50, applyDelay: 300, monitorianPath: '' };
let savingTimer;
let connected = false;
let actionType = '';
const $ = id => document.getElementById(id);

function saveSettings() {
    if (!connected) return;
    socket.send(JSON.stringify({ event: 'setSettings', context, payload: settings }));
}

function scheduleSave() {
    clearTimeout(savingTimer);
    savingTimer = setTimeout(saveSettings, 120);
}

function populateSettings() {
    $('step').value = Number.isInteger(Number(settings.step)) && settings.step !== '' ? settings.step : 5;
    $('preset').value = Number.isInteger(Number(settings.preset)) && settings.preset !== '' ? settings.preset : 50;
    $('applyDelay').value = Number.isInteger(Number(settings.applyDelay)) && settings.applyDelay !== '' ? settings.applyDelay : 300;
    $('monitorianPath').value = settings.monitorianPath || '';
}

function connectElgatoStreamDeckSocket(port, inUUID, event, app, info) {
    uuid = inUUID;
    let actionInfo = {};
    try { actionInfo = JSON.parse(info); } catch { /* empty */ }
    action = actionInfo.action || '';
    context = actionInfo.context || inUUID;
    actionType = action.split('.').pop();
    $('stepWrap').hidden = !(actionType === 'brightness-up' || actionType === 'brightness-down' || actionType === 'brightness-encoder');
    $('presetWrap').hidden = !(actionType === 'brightness-preset' || actionType === 'brightness-encoder');
    $('applyDelayWrap').hidden = actionType === 'brightness-status';
    if (actionType === 'brightness-encoder') $('presetHint').textContent = 'Яркость при нажатии ручки энкодера.';
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onopen = () => {
        connected = true;
        socket.send(JSON.stringify({ event, uuid }));
        socket.send(JSON.stringify({ event: 'getSettings', context }));
    };
    socket.onclose = () => { connected = false; };
    socket.onmessage = eventData => {
        let message;
        try { message = JSON.parse(eventData.data); } catch { return; }
        if (message.event === 'didReceiveSettings') {
            settings = { target: 'linked', step: 5, preset: 50, applyDelay: 300, monitorianPath: '', ...message.payload?.settings };
            if (settings.target !== 'linked') {
                settings.target = 'linked';
                scheduleSave(); // All historical targets migrate to basic commands.
            }
            populateSettings();
        }
    };
}
window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

for (const [field, min, max] of [['step', 1, 25], ['preset', 0, 100], ['applyDelay', 100, 1000]]) {
    $(field).addEventListener('change', () => {
        const value = Number($(field).value);
        if (!Number.isInteger(value)) { populateSettings(); return; }
        settings[field] = Math.max(min, Math.min(max, value));
        $(field).value = settings[field];
        scheduleSave();
    });
}
$('monitorianPath').addEventListener('change', () => {
    settings.monitorianPath = $('monitorianPath').value.trim();
    scheduleSave();
});
