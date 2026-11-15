'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startPolling } = require('../lib/polling');
const { BrightnessController } = require('../lib/controller');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const single = value => [{id:'x', name:'Test screen', brightness:value, selected:true}];

test('polling skips inactive Stream Dock displays, stops cleanly, and uses a 1s production interval', async () => {
    let shouldRun = false;
    let calls = 0;
    const stop = startPolling({ intervalMs: 5, shouldRun: () => shouldRun, tick: async () => { calls++; } });
    try {
        await wait(27);
        assert.equal(calls, 0);
        shouldRun = true;
        await wait(27);
        assert.ok(calls >= 2);
        stop();
        const snapshot = calls;
        await wait(18);
        assert.equal(calls, snapshot);
    } finally { stop(); }
    const script = readFileSync(path.resolve(__dirname,'../index.js'),'utf8');
    assert.match(script, /intervalMs:\s*1000/);
    assert.doesNotMatch(script, /20000/);
});

test('polling never overlaps a slow Monitorian /get and resumes when it finishes', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release;
    const stop = startPolling({ intervalMs: 4, tick: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await new Promise(resolve => { release = resolve; });
        active--;
    } });
    try {
        await wait(40);
        assert.equal(calls, 1);
        assert.equal(maxActive, 1);
        release();
        await wait(40);
        assert.ok(calls > 1);
        assert.equal(maxActive, 1);
    } finally { stop(); if (release) release(); }
});

test('external Monitorian GUI change appears after next /get without overwriting encoder target', async () => {
    let brightness = 35;
    let allowSet;
    const writes = [];
    const controller = new BrightnessController({
        read: async () => single(brightness),
        set: (target, value) => {
            writes.push(value);
            return new Promise(resolve => { allowSet = () => { brightness = value; resolve(single(value)); }; });
        }
    }, { debounceMs: 5 });
    try {
        await controller.read();
        assert.equal(controller.display().title,'35%');
        brightness = 70; // user changes slider directly in Monitorian UI
        await controller.read();
        assert.equal(controller.display().title,'70%');
        const applying = controller.change('linked', 5);
        assert.equal(controller.display().title, '75%');
        // A background read while a local value is pending must NOT overwrite 75%.
        await controller.read();
        assert.equal(controller.display().title,'75%');
        await wait(25);
        assert.deepEqual(writes, [75]);
        brightness = 33; // simulated GUI activity during a pending /set
        await controller.read();
        assert.equal(controller.display().title,'75%');
        allowSet();
        await applying;
        await wait(4); // write finalizer releases the controller after resolving the request
        assert.equal(controller.display().title,'75%');
        brightness = 48;
        await controller.read();
        assert.equal(controller.display().title,'48%');
    } finally { controller.dispose(); }
});
