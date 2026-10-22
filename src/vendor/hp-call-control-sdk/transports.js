/**
 * Browser transports for the call-control engine: WebHID (USB / dongles) and
 * Bluetooth LE (GATT). Both implement the engine's `Platform` interface.
 */
import { Capability, LogLevel, Slot } from './engine.js';

export const SUPPORTED_VENDOR_IDS = Object.freeze([
  0x047f, // Plantronics / Poly
  0x095d, // Polycom
  0x03f0, // HP
]);

export const GATT_SERVICE_UUID = '23c1b9c0-4e04-4a93-91c3-b85e32a5f7b7';
const GATT_NOTIFY_UUID = '23c1b9c0-4e04-4a93-91c3-b85e32a5f7d7';
const GATT_WRITE_UUID = '23c1b9c0-4e04-4a93-91c3-b85e32a5f7c7';

const CONFIRM_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 1500;
const GATT_TIMEOUT_MS = 10000;
const GATT_BUSY_RETRIES = 20;
const GATT_BUSY_DELAY_MS = 100;
const GATT_DRAIN_TIMEOUT_MS = 5000;

const usage = (page, id) => ((page << 16) | id) >>> 0;

const COLLECTION_CAPABILITY = new Map([
  [0x000b, Capability.TELEPHONY],
  [0xffa2, Capability.HID2],
  [0xff1b, Capability.REPLICANT],
  [0xffa0, Capability.LEGACY],
]);

const REPLICANT_USAGE = usage(0xff1b, 0xc1);

const INPUT_SLOTS = new Map([
  [usage(0x0b, 0x20), Slot.HOOK_SWITCH],
  [usage(0x0b, 0x2f), Slot.PHONE_MUTE],
  [usage(0x0b, 0x21), Slot.FLASH],
  [usage(0x0b, 0x24), Slot.REDIAL],
  [usage(0x0b, 0x07), Slot.REJECT],
  [usage(0x09, 0x07), Slot.REJECT],
  [REPLICANT_USAGE, Slot.REPLICANT],
  [usage(0xffa2, 0x8f), Slot.HID2_ENABLED_CHANGED],
  [usage(0xffa2, 0xb7), Slot.HID2_HOOK],
  [usage(0xffa2, 0x61), Slot.HID2_HOOK],
  [usage(0xffa2, 0x9c), Slot.HID2_MUTE_CHANGED],
  [usage(0xffa2, 0xb3), Slot.HID2_FLASH],
  [usage(0xffa2, 0xdd), Slot.HID2_REJECT],
  [usage(0xffa0, 0xb7), Slot.LEGACY_HOOK],
  [usage(0xffa0, 0xb3), Slot.LEGACY_FLASH],
]);

const OUTPUT_SLOTS = new Map([
  [usage(0x08, 0x17), Slot.HOOK_SWITCH],
  [usage(0x08, 0x09), Slot.PHONE_MUTE],
  [usage(0x08, 0x18), Slot.RING],
  [usage(0x08, 0x20), Slot.HOLD],
  [REPLICANT_USAGE, Slot.REPLICANT],
  [usage(0xffa2, 0xb5), Slot.HID2_MUTE],
  [usage(0xffa2, 0x9e), Slot.HID2_RING],
  [usage(0xffa2, 0x22), Slot.HID2_HOLD],
  [usage(0xffa2, 0xdc), Slot.HID2_OFF_HOOK],
  [usage(0xffa2, 0x54), Slot.HID2_CALL_ACTIVE],
]);

const FEATURE_SLOTS = new Map([
  [usage(0xffa2, 0xb5), Slot.HID2_MUTE_STATE],
  [usage(0xffa2, 0x8f), Slot.HID2_ENABLED],
]);

export function createLogger(getLevel) {
  return (level, message) => {
    if (level < getLevel()) return;
    const prefix = 'CCSDK:';
    if (level >= LogLevel.ERROR) console.error(prefix, message);
    else if (level === LogLevel.WARN) console.warn(prefix, message);
    else if (level === LogLevel.INFO) console.info(prefix, message);
    else console.debug(prefix, message);
  };
}

/** Behaviour shared by both transports: timers, confirmation timeout, logging. */
class BaseTransport {
  constructor(log) {
    this.log = log;
    this.onResult = null;
    this.confirmTimer = null;
    this.timers = new Set();
  }

  confirmConnection() {
    this.clearConfirmTimer();
  }

  sendDelayed(slot, data, delayMs, before) {
    const copy = Uint8Array.from(data);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      before?.();
      this.send(slot, copy);
    }, delayMs);
    this.timers.add(timer);
  }

  random() {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  }

  retryConnect() {
    return false;
  }

  /** Reports the opened device's capabilities and arms the confirmation timeout. */
  report(caps) {
    const onResult = this.onResult;
    if (caps !== 0) {
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = null;
        this.log(LogLevel.ERROR, 'Connection confirmation timeout.');
        this.close();
        onResult?.(0);
      }, CONFIRM_TIMEOUT_MS);
    }
    onResult?.(caps);
  }

  clearConfirmTimer() {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }

  clearTimers() {
    this.clearConfirmTimer();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

// ------------------------------------------------------------------ WebHID

/**
 * Splits a report's items into fields, one per usage. Following the HID rules,
 * when an item declares fewer usages than fields the last usage covers the rest.
 */
function layoutFields(items = []) {
  const fields = [];
  let offset = 0;
  for (const item of items) {
    const { reportSize = 0, reportCount = 0 } = item;
    const total = reportSize * reportCount;
    if (item.isRange && item.usageMinimum !== undefined) {
      for (let i = 0; i < reportCount; i++) {
        const u = Math.min(item.usageMinimum + i, item.usageMaximum ?? item.usageMinimum) >>> 0;
        fields.push({ usage: u, offset: offset + i * reportSize, size: reportSize, isAbsolute: item.isAbsolute });
      }
    } else if (item.usages?.length && total) {
      const count = Math.min(item.usages.length, reportCount);
      for (let i = 0; i < count; i++) {
        const size = i + 1 < count ? reportSize : reportSize * (reportCount - i);
        fields.push({ usage: item.usages[i] >>> 0, offset: offset + i * reportSize, size, isAbsolute: item.isAbsolute });
      }
    }
    offset += total; // constant / padding items still occupy bits
  }
  return { fields, bytes: Math.ceil(offset / 8) };
}

function readBits(data, offset, size) {
  const out = new Uint8Array(Math.ceil(size / 8));
  for (let i = 0; i < size; i++) {
    const bit = offset + i;
    if ((data[bit >> 3] >> (bit & 7)) & 1) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

function writeBits(target, offset, size, value) {
  for (let i = 0; i < size; i++) {
    const bit = offset + i;
    const on = (value[i >> 3] >> (i & 7)) & 1;
    if (on) target[bit >> 3] |= 1 << (bit & 7);
    else target[bit >> 3] &= ~(1 << (bit & 7));
  }
}

/** Indexes a report list: reportId -> { fields, bytes } and slot -> { reportId, field }. */
function indexReports(reports, slotMap, reportsById, fieldsBySlot) {
  for (const report of reports ?? []) {
    const layout = layoutFields(report.items);
    const known = layout.fields.filter((f) => slotMap.has(f.usage));
    if (!known.length) continue;
    reportsById.set(report.reportId, layout);
    for (const field of known) {
      const slot = slotMap.get(field.usage);
      if (!fieldsBySlot.has(slot)) fieldsBySlot.set(slot, { reportId: report.reportId, field });
    }
  }
}

export class HidTransport extends BaseTransport {
  constructor(log) {
    super(log);
    this.device = null;
    this.lastProductName = null;
    this.engine = null;
    this.onInputReport = this.onInputReport.bind(this);
    this.onHidDisconnect = this.onHidDisconnect.bind(this);
    navigator.hid?.addEventListener('disconnect', this.onHidDisconnect);
  }

  /** @param {HIDDevice} device */
  connect(device, onResult) {
    this.onResult = onResult;
    this.clearConfirmTimer();
    this.open(device).then(
      (caps) => this.report(caps),
      (error) => {
        this.log(LogLevel.ERROR, `Unable to open headset: ${error?.message ?? error}`);
        this.device = null;
        onResult(0);
      }
    );
    return true;
  }

  async open(device) {
    if (this.device) await this.close();
    if (!device) {
      this.log(LogLevel.ERROR, 'Unable to find selected device');
      return 0;
    }
    if (!SUPPORTED_VENDOR_IDS.includes(device.vendorId)) {
      this.log(LogLevel.ERROR, `Device vendor ID 0x${device.vendorId.toString(16).padStart(4, '0')} not supported`);
      return 0;
    }
    if (!device.opened) await device.open();
    this.device = device;
    this.lastProductName = null;
    this.inputs = { reports: new Map(), slots: new Map(), last: new Map() };
    this.outputs = { reports: new Map(), slots: new Map(), buffers: new Map() };
    this.features = { reports: new Map(), slots: new Map() };

    let caps = 0;
    for (const collection of device.collections) {
      const cap = COLLECTION_CAPABILITY.get(collection.usagePage);
      if (!cap) continue;
      caps |= cap;
      indexReports(collection.inputReports, INPUT_SLOTS, this.inputs.reports, this.inputs.slots);
      indexReports(collection.outputReports, OUTPUT_SLOTS, this.outputs.reports, this.outputs.slots);
      indexReports(collection.featureReports, FEATURE_SLOTS, this.features.reports, this.features.slots);
    }
    // HID2 supersedes the legacy vendor page.
    if (caps & Capability.HID2) caps &= ~Capability.LEGACY;
    device.addEventListener('inputreport', this.onInputReport);
    this.log(LogLevel.INFO, `Opened ${device.productName}, capabilities 0x${caps.toString(16)}`);
    return caps;
  }

  async close() {
    this.clearTimers();
    const device = this.device;
    this.device = null;
    if (!device) return;
    device.removeEventListener('inputreport', this.onInputReport);
    try {
      if (device.opened) await device.close();
    } catch (error) {
      this.log(LogLevel.WARN, `Error closing device: ${error?.message ?? error}`);
    }
  }

  disconnect() {
    if (!this.device) return false;
    this.close();
    return true;
  }

  retryConnect() {
    const name = this.lastProductName;
    if (!name) return false;
    const onResult = this.onResult;
    setTimeout(async () => {
      if (this.device) return;
      const matches = (await navigator.hid.getDevices()).filter((d) => d.productName === name);
      if (matches.length === 1) {
        this.log(LogLevel.INFO, `Reconnecting to ${name}`);
        this.connect(matches[0], onResult);
      } else {
        this.log(LogLevel.WARN, `Cannot reconnect to ${name}: ${matches.length} matching devices`);
        onResult?.(0);
      }
    }, RETRY_DELAY_MS);
    return true;
  }

  onHidDisconnect(event) {
    const device = this.device;
    if (!device || event.device !== device) return;
    this.log(LogLevel.INFO, 'Device disconnected');
    this.lastProductName = device.productName;
    this.clearTimers();
    // The engine either releases the device (closing it) or asks for a retry.
    this.onResult?.(0);
    if (this.device === device) {
      device.removeEventListener('inputreport', this.onInputReport);
      this.device = null;
    }
  }

  onInputReport(event) {
    const layout = this.inputs.reports.get(event.reportId);
    if (!layout) return;
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    this.deliver(event.reportId, layout, data, INPUT_SLOTS, false);
  }

  deliver(reportId, layout, data, slotMap, always) {
    for (const field of layout.fields) {
      const slot = slotMap.get(field.usage);
      if (slot === undefined) continue;
      const value = readBits(data, field.offset, field.size);
      const key = `${reportId}:${slot}`;
      const text = value.join(',');
      // Only changes are reported, except replicant messages and feature reads.
      if (!always && slot !== Slot.REPLICANT && this.inputs.last.get(key) === text) continue;
      if (!always) this.inputs.last.set(key, text);
      this.engine?.onInput(slot, value, field.isAbsolute);
    }
  }

  send(slot, data) {
    if (!this.device) return;
    const output = this.outputs.slots.get(slot);
    if (output) {
      const { reportId, field } = output;
      let buffer = this.outputs.buffers.get(reportId);
      if (!buffer) {
        buffer = new Uint8Array(this.outputs.reports.get(reportId).bytes);
        this.outputs.buffers.set(reportId, buffer);
      }
      writeBits(buffer, field.offset, field.size, data);
      this.device.sendReport(reportId, Uint8Array.from(buffer)).catch((error) => {
        this.log(LogLevel.ERROR, `sendReport(${reportId}) failed: ${error?.message ?? error}`);
      });
      return;
    }
    const feature = this.features.slots.get(slot);
    if (feature) this.readFeature(feature.reportId);
  }

  async readFeature(reportId) {
    const device = this.device;
    try {
      const view = await device.receiveFeatureReport(reportId);
      if (device !== this.device) return;
      let data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (reportId !== 0) {
        if (data.length < 2 || data[0] !== reportId) return;
        data = data.subarray(1);
      }
      this.deliver(reportId, this.features.reports.get(reportId), data, FEATURE_SLOTS, true);
    } catch (error) {
      this.log(LogLevel.ERROR, `receiveFeatureReport(${reportId}) failed: ${error?.message ?? error}`);
    }
  }
}

// ------------------------------------------------------------- Bluetooth LE

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class BleTransport extends BaseTransport {
  constructor(log) {
    super(log);
    this.device = null;
    this.notify = null;
    this.write = null;
    this.writes = Promise.resolve();
    this.engine = null;
    this.onNotification = this.onNotification.bind(this);
    this.onGattDisconnected = this.onGattDisconnected.bind(this);
  }

  /** @param {BluetoothDevice} device */
  connect(device, onResult) {
    this.onResult = onResult;
    this.clearConfirmTimer();
    this.open(device).then((caps) => this.report(caps));
    return true;
  }

  async open(device) {
    if (this.device) await this.close();
    this.device = device;
    try {
      device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
      const server = device.gatt.connected ? device.gatt : await this.connectGatt(device);
      const service = await withTimeout(server.getPrimaryService(GATT_SERVICE_UUID), GATT_TIMEOUT_MS, 'getPrimaryService');
      this.notify = await withTimeout(service.getCharacteristic(GATT_NOTIFY_UUID), GATT_TIMEOUT_MS, 'getCharacteristic(notify)');
      this.write = await withTimeout(service.getCharacteristic(GATT_WRITE_UUID), GATT_TIMEOUT_MS, 'getCharacteristic(write)');
      this.notify.addEventListener('characteristicvaluechanged', this.onNotification);
      await this.notify.startNotifications();
      this.log(LogLevel.INFO, `Opened ${device.name ?? 'Bluetooth device'}`);
      return Capability.REPLICANT;
    } catch (error) {
      this.log(LogLevel.ERROR, `Error during Bluetooth device connection: ${error?.message ?? error}`);
      this.release();
      return 0;
    }
  }

  async connectGatt(device) {
    try {
      const server = await device.gatt.connect();
      if (server.connected) return server;
    } catch (error) {
      this.log(LogLevel.WARN, `gatt.connect() failed: ${error?.message ?? error}`);
    }
    // Out of range or asleep: wait for an advertisement, then try once more.
    if (typeof device.watchAdvertisements !== 'function') throw new Error('GATT connection failed');
    try {
      if (!device.watchingAdvertisements) await device.watchAdvertisements();
      await withTimeout(
        new Promise((resolve) => device.addEventListener('advertisementreceived', resolve, { once: true })),
        GATT_TIMEOUT_MS,
        'advertisementreceived'
      );
      return await device.gatt.connect();
    } finally {
      try {
        if (device.watchingAdvertisements) device.unwatchAdvertisements?.();
      } catch {}
    }
  }

  release() {
    this.clearTimers();
    this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.notify?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.device = this.notify = this.write = null;
    this.writes = Promise.resolve();
  }

  async close() {
    const { device, notify, writes } = this;
    this.release();
    if (!device?.gatt?.connected) return;
    try {
      await notify?.stopNotifications();
      await Promise.race([writes.catch(() => {}), new Promise((r) => setTimeout(r, GATT_DRAIN_TIMEOUT_MS))]);
    } catch (error) {
      this.log(LogLevel.WARN, `Error during Bluetooth disconnection: ${error?.message ?? error}`);
    }
  }

  disconnect() {
    if (!this.device) return false;
    this.close();
    return true;
  }

  onGattDisconnected() {
    this.log(LogLevel.INFO, 'Bluetooth device disconnected');
    this.release();
    this.onResult?.(0);
  }

  onNotification(event) {
    const view = event.target.value;
    if (view.byteLength < 3) return;
    const data = new Uint8Array(view.buffer, view.byteOffset, 3);
    this.engine?.onInput(Slot.REPLICANT, Uint8Array.from(data), true);
  }

  send(slot, data) {
    if (slot !== Slot.REPLICANT || !this.write) return;
    const characteristic = this.write;
    const message = Uint8Array.from(data);
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            await characteristic.writeValueWithResponse(message);
            return;
          } catch (error) {
            if (attempt >= GATT_BUSY_RETRIES || !/already in progress/i.test(error?.message ?? '')) throw error;
            await new Promise((r) => setTimeout(r, GATT_BUSY_DELAY_MS));
          }
        }
      });
    this.writes.catch((error) => this.log(LogLevel.ERROR, `Bluetooth write failed: ${error?.message ?? error}`));
  }
}
