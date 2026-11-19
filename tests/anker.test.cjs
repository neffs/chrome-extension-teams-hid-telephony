const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const babel = require('@babel/core');

// Use the project's Babel dependency to load the extension's ES module in Node.
const filename = path.resolve(__dirname, '../src/vendor/anker.js');
const compiled = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    configFile: false,
    babelrc: false,
    presets: [[require.resolve('@babel/preset-env'), {
        targets: { node: 'current' },
        modules: 'commonjs',
    }]],
});
const adapterModule = new Module(filename, module);
adapterModule.filename = filename;
adapterModule.paths = module.paths;
adapterModule._compile(compiled.code, filename);
const AnkerService = adapterModule.exports.default;

function fixture(t) {
    const reports = [];
    const device = {
        vendorId: 0x291a,
        productId: 0x3308,
        productName: 'Anker PowerConf S330',
        opened: false,
        async open() { this.opened = true; },
        async close() { this.opened = false; },
        addEventListener() {},
        removeEventListener() {},
        async sendReport(id, bytes) { reports.push([id, Array.from(bytes)]); },
    };
    const hid = {
        async getDevices() { return [device]; },
        addEventListener() {},
        removeEventListener() {},
    };
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { hid },
    });
    t.after(() => {
        if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
        else delete globalThis.navigator;
    });
    const adapter = new AnkerService({ logger: { debug() {}, error() {} } });
    const input = (value) => adapter.handleInput({
        reportId: 2,
        data: new DataView(Uint8Array.of(value).buffer),
    });
    return { adapter, device, reports, hid, input };
}

test('recognizes only S330 microphone labels', (t) => {
    const { adapter } = fixture(t);
    assert(adapter.deviceLabelMatchesVendor('Microphone (Anker PowerConf S330)'));
    assert(!adapter.deviceLabelMatchesVendor('Anker PowerConf S500'));
    assert(!adapter.deviceLabelMatchesVendor(null));
});

test('opens the device, writes 12-byte indicators and cleans up', async (t) => {
    const { adapter, device, reports } = fixture(t);
    await adapter.connect();
    await adapter.outgoingCall({ conversationId: 'outgoing' });
    await adapter.setMute(true);
    assert(reports.some(([id, bytes]) => id === 6 && bytes[0] === 2));
    assert(reports.some(([id, bytes]) => id === 4 && bytes[0] === 1));
    assert(reports.every(([, bytes]) => bytes.length === 12));
    await adapter.disconnect();
    assert.equal(device.opened, false);
    assert.equal(adapter.conversationId, null);
    assert.equal(adapter.isConnected, false);
    assert(reports.some(([id, bytes]) => id === 6 && bytes[0] === 0));
});

test('forwards mute state once per change and ignores idle reports', async (t) => {
    const { adapter, input } = fixture(t);
    const states = [];
    adapter.on('deviceMuteStatusChanged', event => states.push(event.body.isMuted));
    input(9);
    await adapter.connect();
    await adapter.outgoingCall({ conversationId: 'outgoing' });
    input(9);
    input(9);
    input(1);
    input(1);
    assert.deepEqual(states, [true, false]);
    await adapter.disconnect();
});

test('initializes hardware before confirming a device answer, then supports mute and hangup', async (t) => {
    const { adapter, reports, input } = fixture(t);
    const answered = [];
    const ended = [];
    const mute = [];
    adapter.on('deviceAnsweredCall', event => {
        assert.equal(adapter.ringing, false);
        assert(reports.some(([id, bytes]) => id === 6 && bytes[0] === 2));
        answered.push(event.body.conversationId);
    });
    adapter.on('deviceEndedCall', event => ended.push(event.body.conversationId));
    adapter.on('deviceMuteStatusChanged', event => mute.push(event.body.isMuted));
    await adapter.connect();
    await adapter.incomingCall({ conversationId: 'incoming' });
    input(3);
    input(3);
    await adapter.writeQueue;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(answered, ['incoming']);
    assert.deepEqual(ended, []);
    input(9);
    input(1);
    assert.deepEqual(mute, [true, false]);
    input(3);
    input(3);
    await adapter.writeQueue;
    assert.deepEqual(ended, ['incoming']);
    assert.equal(adapter.conversationId, null);
    await adapter.disconnect();
});

test('requests a narrowly filtered device picker from the permission callback', async (t) => {
    const { adapter, device, hid } = fixture(t);
    hid.getDevices = async () => [];
    hid.requestDevice = async options => {
        assert.deepEqual(options.filters, [{ vendorId: 0x291a, productId: 0x3308 }]);
        return [device];
    };
    let callback;
    adapter.on('webHidPermissionRequested', event => { callback = event.body.callback; });
    await adapter.connect();
    assert.equal(typeof callback, 'function');
    await callback();
    assert.equal(adapter.isConnected, true);
    await adapter.disconnect();
});
