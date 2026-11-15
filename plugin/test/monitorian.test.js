'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseBrightness, MonitorianClient, validateTarget } = require('../lib/monitorian');
const { BrightnessController, normalizeSettings, levelForTarget } = require('../lib/controller');

const ONE = 'DISPLAY\\ABC\\123 Dell U2723QE 35 B *\r\n';
const RESPONSE = ONE + 'DISPLAY\\DEF\\456 LG UltraWide 75 B\r\n';

function mockClient(handler) {
    const calls = [];
    const client = new MonitorianClient({
        platform: 'win32', exists: () => true,
        env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
        exec: (exe, args, opts, cb) => {
            calls.push({ exe, args, opts });
            const value = handler(args);
            if (value instanceof Error) cb(value, '', '');
            else cb(null, value, '');
        }
    });
    return { client, calls };
}

test('parse Monitorian response and distinguish selected monitor from the full group', () => {
    const rows = parseBrightness(RESPONSE);
    assert.deepEqual(rows, [
        { id: 'DISPLAY\\ABC\\123', name: 'Dell U2723QE', brightness: 35, selected: true },
        { id: 'DISPLAY\\DEF\\456', name: 'LG UltraWide', brightness: 75, selected: false }
    ]);
    assert.equal(levelForTarget(rows, 'linked'), 35);
    assert.equal(levelForTarget(rows, 'premium-all'), 'mixed');
    assert.equal(levelForTarget(rows, 'DISPLAY\\DEF\\456'), 75);
});

test('migrate all saved monitor selections to basic commands without all', () => {
    assert.equal(normalizeSettings({}).target, 'linked');
    assert.equal(normalizeSettings({target:'all'}).target, 'linked');
    assert.equal(normalizeSettings({target:'selected'}).target, 'linked');
    assert.equal(normalizeSettings({target:'premium-all'}).target, 'linked');
    assert.equal(normalizeSettings({target:'DISPLAY\\DEF\\456'}).target, 'linked');
    assert.equal(normalizeSettings({step: 300, preset: -5}).step, 5);
    assert.equal(normalizeSettings({step: 3, preset: 0}).preset, 0);
    assert.throws(() => validateTarget('/set all 100'));
    assert.throws(() => validateTarget('x\nHello'));
});

test('basic mode NEVER adds all or device ID to CLI calls', async () => {
    const { client, calls } = mockClient(() => ONE);
    await client.read();
    await client.read('', 'all');
    await client.change('linked', -5);
    await client.change('all', +10); // defensive compatibility for v0.1
    await client.set('selected', 55);
    assert.deepEqual(calls.map(c => c.args), [
        ['/get'], ['/get'], ['/set', '-5'], ['/set', '+10'], ['/set', '55']
    ]);
    assert.equal(calls[0].opts.shell, false);
    assert.match(calls[0].exe, /WindowsApps/);
});

test('no extended access means no accidental /set all or write to another monitor', async () => {
    const { client, calls } = mockClient(args => args[0] === '/get' ? ONE : 'unexpected write');
    await assert.rejects(client.change('premium-all', +5), /не подтверждена/);
    await assert.rejects(client.set('DISPLAY\\DEF\\456', 50), /не подтверждена/);
    assert.deepEqual(calls.map(c => c.args), [['/get','all'], ['/get','all']]);
});

test('with multi-monitor access /get all enables individual and group commands', async () => {
    const { client, calls } = mockClient(args => args[0] === '/get' && args[1] === 'DISPLAY\\DEF\\456' ?
        'DISPLAY\\DEF\\456 LG UltraWide 75 B\r\n' : RESPONSE);
    const full = await client.read('', 'premium-all');
    assert.equal(full.length, 2);
    await client.change('premium-all', +10);
    await client.set('DISPLAY\\DEF\\456', 60);
    const individual = await client.read('', 'DISPLAY\\DEF\\456');
    assert.equal(individual[0].id, 'DISPLAY\\DEF\\456');
    assert.deepEqual(calls.map(c => c.args), [
        ['/get','all'], ['/set','all','+10'], ['/set','DISPLAY\\DEF\\456','60'], ['/get','DISPLAY\\DEF\\456']
    ]);
});

test('missing CLI output fails visibly; command text shown for troubleshooting', async () => {
    const {client} = mockClient(() => 'Command is invalid');
    await assert.rejects(client.read(), /Command is invalid/);
});


const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const single = value => [{id:'x',name:'Monitor',brightness:value,selected:true}];

test('encoder/buttons show optimistic value instantly and send only latest absolute set', async () => {
    const seen = [];
    const calls = [];
    const controller = new BrightnessController({
        read: async () => single(35),
        set: async (target, brightness) => { calls.push([target, brightness]); return single(brightness); }
    }, { debounceMs: 35, onChange: (path, target, view) => seen.push(view.title) });
    await controller.read();
    const requests = [controller.change('linked',5),controller.change('linked',5),controller.change('linked',5)];
    assert.equal(controller.display().title, '50%'); // no Monitorian await!
    assert.equal(seen.at(-1),'50%');
    assert.deepEqual(calls, []);
    await Promise.all(requests);
    assert.deepEqual(calls, [['linked',50]]);
    assert.equal(controller.display().title,'50%');
    controller.dispose();
});

test('slow write does not roll back LCD, and latest target supersedes intermediate commands', async () => {
    const seen = [];
    const calls = [];
    let finishFirst;
    const controller = new BrightnessController({
        read: async () => single(40),
        set: (target, brightness) => {
            calls.push(brightness);
            if (calls.length === 1) return new Promise(resolve => { finishFirst = () => resolve(single(brightness)); });
            return Promise.resolve(single(brightness));
        }
    }, { debounceMs: 8, onChange: (p,t,view) => seen.push(view.title) });
    await controller.read();
    const first = controller.change('linked', 5);
    await pause(25);
    assert.deepEqual(calls,[45]);
    const second = controller.change('linked',5);
    const third = controller.change('linked',5);
    assert.equal(controller.display().title, '55%');
    await pause(25);
    assert.deepEqual(calls, [45]); // at most one in flight
    finishFirst();
    await Promise.all([first, second, third]);
    assert.deepEqual(calls,[45,55]); // no intermediate /set 50
    assert.equal(controller.display().title,'55%');
    assert.equal(seen.slice(seen.indexOf('55%')).every(x => x === '55%'),true);
    controller.dispose();
});

test('startup without baseline shows accumulated +/- steps then resolves against /get', async () => {
    let finishGet;
    const calls = [];
    const controller = new BrightnessController({
        read: async () => new Promise(resolve => { finishGet = () => resolve(single(42)); }),
        set: async (t,v) => { calls.push(v); return single(v); }
    }, {debounceMs:8});
    const first = controller.change('linked', 5);
    const second = controller.change('linked', 10);
    assert.equal(controller.display().title, '+15%');
    await pause(5); // queued CLI gets its turn to start
    finishGet();
    await Promise.all([first,second]);
    assert.deepEqual(calls,[57]);
    assert.equal(controller.display().title,'57%');
    controller.dispose();
});

test('stale periodic read cannot overwrite brightness selected during pending read', async () => {
    let finishGet;
    const controller = new BrightnessController({
        read: () => new Promise(resolve => { finishGet = () => resolve(single(20)); }),
        set: async (t,v) => single(v)
    }, {debounceMs:8});
    const fetching = controller.read();
    await pause(5);
    const setting = controller.set('linked',80);
    assert.equal(controller.display().title,'80%');
    finishGet();
    await fetching;
    assert.equal(controller.display().title,'80%');
    await setting;
    assert.equal(controller.display().title,'80%');
    controller.dispose();
});

test('preset overrides increments, clamps at boundaries, and preserves target/path isolation', async () => {
    const calls = [];
    const controller = new BrightnessController({
        read: async (path) => single(path === 'B.exe' ? 30 : 90),
        set: async (t,v,p) => { calls.push([p,t,v]); return single(v); }
    }, {debounceMs:8});
    await Promise.all([controller.read('A.exe'),controller.read('B.exe')]);
    const updates = [controller.change('linked',20,'A.exe'),controller.set('linked', 33,'A.exe'),controller.change('linked',-5,'B.exe')];
    assert.equal(controller.display('A.exe').title,'33%');
    assert.equal(controller.display('B.exe').title,'25%');
    await Promise.all(updates);
    assert.deepEqual(calls,[['A.exe','linked',33],['B.exe','linked',25]]);
    await controller.change('linked',500,'A.exe');
    assert.equal(controller.display('A.exe').title,'100%');
    controller.dispose();
});

test('failed write displays error and next attempt starts from last confirmed value', async () => {
    let first = true;
    const controller = new BrightnessController({
        read: async () => single(20),
        set: async (t,v) => {
            if (first) { first=false; throw new Error('DDC failed'); }
            return single(v);
        }
    }, {debounceMs:8});
    await controller.read();
    await assert.rejects(controller.change('linked',5),/DDC failed/);
    assert.equal(controller.display().title,'ОШИБ.');
    const another = controller.change('linked',5);
    assert.equal(controller.display().title,'25%');
    await another;
    assert.equal(controller.display().title,'25%');
    controller.dispose();
});

test('settings migrate, preserve user preferences and default to 300ms debounce', () => {
    assert.equal(normalizeSettings({}).applyDelay, 300);
    assert.equal(normalizeSettings({applyDelay: 200}).applyDelay,200);
    assert.equal(normalizeSettings({applyDelay: 20000}).applyDelay,300);
    assert.equal(normalizeSettings({target:'all',step:3,preset:25}).target,'linked');
});

test('failed startup /get does not prevent immediate preset /set', async () => {
    let failRead;
    const calls = [];
    const controller = new BrightnessController({
        read: () => new Promise((resolve, reject) => { failRead = () => reject(new Error('Temporary read failure')); }),
        set: async (t, v) => { calls.push(v); return single(v); }
    }, {debounceMs:8});
    const reading = controller.read();
    await pause(5);
    const pressing = controller.set('linked',75);
    assert.equal(controller.display().title, '75%');
    failRead();
    await assert.rejects(reading,/Temporary read failure/);
    await pressing;
    assert.deepEqual(calls,[75]);
    controller.dispose();
});

test('a successful refresh clears old error state', async () => {
    let fail = true;
    const controller = new BrightnessController({
        read: async () => single(30),
        set: async (t,v) => { if (fail) {fail = false; throw new Error('Disconnected');} return single(v); }
    }, {debounceMs:8});
    await controller.read();
    await assert.rejects(controller.set('linked',40),/Disconnected/);
    assert.equal(controller.display().title,'ОШИБ.');
    await controller.read();
    assert.equal(controller.display().title,'30%');
    controller.dispose();
});


test('property inspector has no monitor section or advanced monitor buttons', () => {
    const fs = require('node:fs');
    const html = fs.readFileSync(require('node:path').resolve(__dirname, '../../propertyInspector/index.html'), 'utf8');
    const script = fs.readFileSync(require('node:path').resolve(__dirname, '../../propertyInspector/index.js'), 'utf8');
    assert.doesNotMatch(html, /id="target"|id="refreshAdvanced"|id="monitorStatus"|for="target"/);
    assert.doesNotMatch(script, /getElementById\(['"]target|refreshAdvancedMonitors|requestMonitors\(/);
});
