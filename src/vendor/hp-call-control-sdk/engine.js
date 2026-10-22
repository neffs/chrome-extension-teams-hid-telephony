/**
 * Call-control state machine for HP / Poly headsets.
 *
 * Independent JavaScript implementation written from an interoperability
 * specification (see ./PROTOCOL.md). It is transport agnostic: it talks to the
 * device through abstract "usage slots" and a small platform interface, so the
 * same logic drives USB (WebHID) and Bluetooth LE devices.
 */

/** Builds a TypeScript-style numeric enum (with reverse mapping, e.g. `SdkEvent[0] === 'ANSWER'`). */
function numericEnum(names) {
  const result = {};
  names.forEach((name, value) => {
    result[(result[name] = value)] = name;
  });
  return Object.freeze(result);
}

/** Call state reported by the application. */
export const CallState = numericEnum([
  'IDLE',
  'INCOMING',
  'OUTGOING',
  'ACTIVE',
  'ACTIVE_AND_INCOMING',
  'ACTIVE_AND_HELD',
  'HELD',
]);

/** Events raised towards the application. */
export const SdkEvent = numericEnum([
  'ANSWER',
  'TERMINATE',
  'REJECT',
  'HOLD',
  'RESUME',
  'REDIAL',
  'FLASH',
  'MUTE',
  'UNMUTE',
  'DISCONNECT',
  'CONNECT_SUCCESS',
  'CONNECT_FAILED',
]);

/**
 * Usage slots exchanged with a transport. Inputs, outputs and feature reports
 * share one numbering space; the transport maps them to HID usages.
 */
export const Slot = Object.freeze({
  // Telephony page (0x0B) / LED page (0x08)
  HOOK_SWITCH: 0, // in  0x0B:0x20      | out LED off-hook 0x08:0x17
  PHONE_MUTE: 1, //  in  0x0B:0x2F      | out LED mute     0x08:0x09
  FLASH: 2, //       in  0x0B:0x21
  RING: 3, //                            out LED ring     0x08:0x18
  REDIAL: 4, //      in  0x0B:0x24
  REJECT: 5, //      in  0x0B:0x07, 0x09:0x07
  HOLD: 6, //                            out LED hold     0x08:0x20
  // Replicant protocol (0xFF1B:0xC1), 3-byte messages, also used over BLE
  REPLICANT: 7,
  // HID2 vendor page (0xFFA2)
  HID2_ENABLED_CHANGED: 8, // in 0xFFA2:0x8F
  HID2_HOOK: 9, //           in 0xFFA2:0xB7, 0xFFA2:0x61
  HID2_MUTE: 10, //          out 0xFFA2:0xB5 (1 = unmute, 2 = mute)
  HID2_MUTE_CHANGED: 11, //  in 0xFFA2:0x9C
  HID2_MUTE_STATE: 12, //    feature 0xFFA2:0xB5
  HID2_FLASH: 13, //         in 0xFFA2:0xB3
  HID2_RING: 14, //          out 0xFFA2:0x9E
  HID2_REJECT: 15, //        in 0xFFA2:0xDD
  HID2_HOLD: 16, //          out 0xFFA2:0x22 (1 = held, 2 = released)
  HID2_OFF_HOOK: 17, //      out 0xFFA2:0xDC
  HID2_CALL_ACTIVE: 18, //   out 0xFFA2:0x54 (1 = active, 2 = idle)
  HID2_ENABLED: 19, //       feature 0xFFA2:0x8F
  // Legacy vendor page (0xFFA0)
  LEGACY_HOOK: 20, //        in 0xFFA0:0xB7
  LEGACY_FLASH: 21, //       in 0xFFA0:0xB3
});

/** Capability bits a transport reports when a device has been opened. */
export const Capability = Object.freeze({
  TELEPHONY: 1,
  HID2: 2,
  REPLICANT: 4,
  LEGACY: 16,
});

/** Log levels understood by `platform.log`. */
export const LogLevel = Object.freeze({ DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 });

const Mode = Object.freeze({ NONE: 0, TELEPHONY: 1, HID2: 2, REPLICANT: 4 });
const Link = Object.freeze({ CONNECTING: 1, CONNECTED: 2, FAILED: 3 });

// Indicator bits tracked per context (what the headset was last told).
const LED_RING = 1;
const LED_OFF_HOOK = 2;
const LED_HOLD = 4;
const LED_MUTE = 8;

const Op = Object.freeze({
  APP_ID: 0,
  REREGISTER: 1,
  FALLBACK: 2,
  PING: 3,
  RELEASE: 4,
  HOOK: 10,
  MUTE: 11,
  FLASH: 12,
  REDIAL: 13,
  REJECT: 14,
  RING: 15,
  HOLD: 16,
});

// HID2 mute confirmation while HELD on a device running in telephony mode.
const Held = Object.freeze({
  IDLE: 0,
  MUTE_PENDING: 1,
  UNSUPPORTED: 2,
  MUTE_AGAIN_PENDING: 3,
  MUTED: 4,
  UNMUTE_PENDING: 5,
  UNMUTED: 6,
});

const HID2_MUTE_POLL_MS = 200;
const HID2_MUTE_MAX_POLLS = 25;
const HELD_MUTE_POLL_MS = 500;
const REREGISTER_MAX_DELAY_MS = 5000;
const OFF_HOOK_SETTLE_MS = 2;

const isCallActive = (state) => state >= CallState.OUTGOING && state <= CallState.ACTIVE_AND_HELD;
const isRinging = (state) =>
  state === CallState.INCOMING || state === CallState.ACTIVE_AND_INCOMING;

/**
 * @typedef {object} Platform
 * @property {(onResult: (capabilities: number) => void, bluetooth: boolean) => boolean} connect
 * @property {() => boolean} disconnect
 * @property {() => boolean} retryConnect
 * @property {() => void} confirmConnection
 * @property {(slot: number, data: Uint8Array) => void} send
 *   Writes an output slot; an empty `data` on a feature slot requests a read.
 * @property {(slot: number, data: Uint8Array, delayMs: number, before?: () => void) => void} sendDelayed
 * @property {() => number} random  Unsigned 32-bit random number.
 * @property {(level: number, message: string) => void} log
 */

export class CallControlEngine {
  /** @param {Platform} platform */
  constructor(platform) {
    this.platform = platform;
    this.context = null;
  }

  // ---------------------------------------------------------------- API

  /** Registers (or replaces) the event handler. */
  registerEventHandler(handler) {
    if (!this.context) this.context = newContext();
    this.context.handler = handler;
    return true;
  }

  /** Starts connecting to the device selected by the platform. */
  connect(bluetooth = false) {
    if (!this.context) this.context = newContext();
    const ctx = this.context;
    if (typeof ctx.handler !== 'function') {
      this.error('No event handler registered.');
      return false;
    }
    if (ctx.device) {
      if (ctx.device.link === Link.CONNECTING) {
        this.error('The current headset must not be in a connecting state when connect is requested.');
        this.emit(ctx, SdkEvent.CONNECT_FAILED);
        return false;
      }
      this.releaseDevice(ctx);
    }
    // Indicator state survives a reconnect so the headset is not re-told.
    ctx.callState = CallState.IDLE;
    ctx.appId = 0;
    ctx.waitingForAppId = false;
    ctx.lastMute = 0;
    ctx.device = newDevice();
    return this.platform.connect((caps) => this.onCapabilities(caps), bluetooth);
  }

  /** Disconnects and forgets all call state. */
  disconnect() {
    const ctx = this.context;
    if (!ctx) return false;
    const result = ctx.device ? this.releaseDevice(ctx) : true;
    Object.assign(ctx, newContext(), { handler: ctx.handler });
    return result;
  }

  setCallState(state) {
    const ctx = this.connectedContext('set_call_state');
    if (!ctx || !(state >= 0 && state <= 6)) return false;
    const dev = ctx.device;
    ctx.callState = state;

    let leds = ctx.leds & LED_MUTE;
    switch (state) {
      case CallState.INCOMING:
        leds |= LED_RING;
        break;
      case CallState.OUTGOING:
      case CallState.ACTIVE:
        leds |= LED_OFF_HOOK;
        break;
      case CallState.ACTIVE_AND_INCOMING:
        leds |= LED_RING | LED_OFF_HOOK;
        break;
      case CallState.ACTIVE_AND_HELD:
        leds |= dev.mode === Mode.REPLICANT ? LED_HOLD | LED_OFF_HOOK : LED_OFF_HOOK;
        break;
      case CallState.HELD:
        leds |= LED_HOLD;
        if (this.tracksHeldMute(dev)) this.requestMuteState(HELD_MUTE_POLL_MS);
        break;
    }

    const changed = ctx.leds ^ leds;
    let offHookDelay = 0;
    if (changed & LED_RING) {
      this.sendIndicator(ctx, Slot.RING, Slot.HID2_RING, Op.RING, leds & LED_RING ? 1 : 0);
      offHookDelay = OFF_HOOK_SETTLE_MS;
    }
    if (changed & LED_HOLD) {
      const on = leds & LED_HOLD ? 1 : 0;
      this.sendIndicator(ctx, Slot.HOLD, Slot.HID2_HOLD, Op.HOLD, on, on ? 1 : 2);
      offHookDelay = OFF_HOOK_SETTLE_MS;
    }

    if (dev.mode === Mode.HID2 && state === CallState.HELD) {
      // HID2 keeps the call off-hook while held.
      leds |= LED_OFF_HOOK;
    } else {
      const wasOffHook = (ctx.leds & LED_OFF_HOOK) !== 0;
      const offHook = (leds & LED_OFF_HOOK) !== 0;
      if (wasOffHook !== offHook) {
        this.sendOffHook(ctx, offHook ? 1 : 0, offHookDelay);
      } else if (dev.mode === Mode.HID2 && offHook && state === CallState.ACTIVE) {
        // HID2 devices are re-told whenever a call becomes active.
        this.sendHid2OffHook(1, offHookDelay);
      }
    }

    ctx.leds = leds;
    return true;
  }

  setMuteState(muted) {
    const ctx = this.connectedContext('set_mute_state');
    if (!ctx) return false;
    const dev = ctx.device;
    const mute = muted ? 1 : 0;

    if (mute !== (ctx.leds & LED_MUTE ? 1 : 0)) {
      if (this.tracksHeldMute(dev) && ctx.callState === CallState.HELD) {
        dev.pollCount = 0;
        if (mute) dev.held = dev.held === Held.IDLE ? Held.MUTE_PENDING : Held.MUTE_AGAIN_PENDING;
        else dev.held = dev.held === Held.MUTE_PENDING ? Held.IDLE : Held.UNMUTE_PENDING;
      }
      this.sendMute(ctx, mute);
    }
    // In HID2 mode the headset owns the mute state; it is learnt from feature reads.
    if (dev.mode !== Mode.HID2) ctx.leds = (ctx.leds & ~LED_MUTE) | (mute ? LED_MUTE : 0);
    ctx.lastMute = mute;
    return true;
  }

  // ------------------------------------------------------ platform callbacks

  /** Called by the platform once the device is open (or with 0 when it is gone). */
  onCapabilities(caps) {
    const ctx = this.context;
    const dev = ctx?.device;
    if (!dev) {
      this.error('Failed to handle connection event: no device context');
      return;
    }
    const previous = dev.caps;
    dev.caps = caps;

    if (caps === 0) {
      dev.mode = Mode.NONE;
      if (previous === Capability.HID2 && this.platform.retryConnect()) return;
      let event;
      if (previous === Capability.HID2 || dev.link === Link.CONNECTING) event = SdkEvent.CONNECT_FAILED;
      else if (dev.link === Link.CONNECTED) event = SdkEvent.DISCONNECT;
      else return;
      ctx.device = null;
      this.emit(ctx, event);
      this.platform.disconnect();
      return;
    }

    if (caps & Capability.HID2) {
      // Ask whether HID2 is enabled; the answer selects the mode.
      this.platform.send(Slot.HID2_ENABLED, new Uint8Array(0));
    } else if (caps & Capability.REPLICANT) {
      this.startReplicant(ctx);
    } else if (caps & Capability.TELEPHONY) {
      dev.mode = Mode.TELEPHONY;
      this.connectionResult(ctx, true);
    }
  }

  /** Called by the platform for every changed input field / feature read. */
  onInput(slot, data, isAbsolute) {
    const ctx = this.context;
    if (slot === Slot.REPLICANT) {
      if (data.length === 3) this.onReplicant(ctx, data[0], data[1], data[2]);
      return;
    }
    if (data.length !== 1) return;
    const dev = ctx?.device;
    if (!dev || (dev.link !== Link.CONNECTING && dev.link !== Link.CONNECTED)) {
      this.error(`Failed to notify callback of input: context not found for slot ${slot}`);
      return;
    }
    const value = data[0];
    const pressed = value === 1 ? 1 : 0;

    switch (slot) {
      case Slot.HOOK_SWITCH:
      case Slot.PHONE_MUTE:
      case Slot.FLASH:
      case Slot.REDIAL:
      case Slot.REJECT:
      case Slot.LEGACY_HOOK:
      case Slot.LEGACY_FLASH:
        if (dev.mode === Mode.TELEPHONY || dev.telephonyFallback) {
          this.onButton(ctx, slot, pressed, isAbsolute);
        }
        break;
      case Slot.HID2_HOOK:
      case Slot.HID2_FLASH:
      case Slot.HID2_REJECT:
        if (dev.mode === Mode.HID2) this.onButton(ctx, slot, pressed, isAbsolute);
        break;
      case Slot.HID2_ENABLED_CHANGED:
        this.platform.send(Slot.HID2_ENABLED, new Uint8Array(0));
        break;
      case Slot.HID2_MUTE_CHANGED:
        dev.pollCount = 0;
        this.platform.send(Slot.HID2_MUTE_STATE, new Uint8Array(0));
        break;
      case Slot.HID2_MUTE_STATE:
        if (dev.mode === Mode.TELEPHONY) this.onHeldMuteState(ctx, value);
        else if (dev.mode === Mode.HID2) this.onButton(ctx, slot, value, isAbsolute);
        break;
      case Slot.HID2_ENABLED:
        this.onHid2Enabled(ctx, value !== 0);
        break;
    }
  }

  // ---------------------------------------------------------------- inputs

  onButton(ctx, slot, value, isAbsolute) {
    const dev = ctx.device;
    switch (slot) {
      case Slot.HOOK_SWITCH:
        if (!dev.legacyHookActive) this.onHook(ctx, value, isAbsolute);
        break;
      case Slot.LEGACY_HOOK:
        if (dev.caps & Capability.LEGACY) dev.legacyHookActive = true;
        this.onHook(ctx, value, isAbsolute);
        break;
      case Slot.HID2_HOOK:
        this.onHook(ctx, value, isAbsolute);
        break;
      case Slot.PHONE_MUTE:
        if (dev.mode === Mode.HID2) break;
        if (isAbsolute) this.reportMute(ctx, value === 1);
        else if (value === 1) this.reportMute(ctx, !(ctx.leds & LED_MUTE));
        break;
      case Slot.FLASH:
        if (value === 1 && !dev.legacyHookActive) this.emit(ctx, SdkEvent.FLASH);
        break;
      case Slot.LEGACY_FLASH:
        if (dev.caps & Capability.LEGACY) dev.legacyHookActive = true;
        if (value === 1) this.emit(ctx, SdkEvent.FLASH);
        break;
      case Slot.HID2_FLASH:
        if (value === 1) this.emit(ctx, SdkEvent.FLASH);
        break;
      case Slot.REDIAL:
        if (value === 1) this.emit(ctx, SdkEvent.REDIAL);
        break;
      case Slot.REJECT:
      case Slot.HID2_REJECT:
        if (value === 1 && isRinging(ctx.callState)) this.emit(ctx, SdkEvent.REJECT);
        break;
      case Slot.HOLD:
        if (value === 1) this.emit(ctx, SdkEvent.HOLD);
        else if (value === 0) this.emit(ctx, SdkEvent.RESUME);
        break;
      case Slot.HID2_MUTE_STATE:
        if (isAbsolute) this.onHid2MuteState(ctx, value);
        else if (value === 1) this.reportMute(ctx, !(ctx.leds & LED_MUTE));
        break;
    }
  }

  onHook(ctx, value, isAbsolute) {
    // Absolute hook switches report the level; relative ones toggle on press.
    if (value === 1 && ctx.callState === CallState.INCOMING) {
      this.emit(ctx, SdkEvent.ANSWER);
    } else if ((isAbsolute ? value === 0 : value === 1) && isCallActive(ctx.callState)) {
      this.emit(ctx, SdkEvent.TERMINATE);
    }
  }

  /** HID2 mute feature: 0 = unmuted, 2 = muted, anything else = still changing. */
  onHid2MuteState(ctx, value) {
    const dev = ctx.device;
    if (value === 0 || value === 2) {
      ctx.leds = value ? ctx.leds | LED_MUTE : ctx.leds & ~LED_MUTE;
      dev.pollCount = 0;
      this.reportMute(ctx, value === 2);
      return;
    }
    if (dev.pollCount >= HID2_MUTE_MAX_POLLS) {
      this.error(`HID2 mute feature failed to settle after ${HID2_MUTE_MAX_POLLS} attempts.`);
      return;
    }
    dev.pollCount++;
    this.requestMuteState(HID2_MUTE_POLL_MS);
    if (value === 1) this.reportMute(ctx, false);
    else if (value === 3) this.reportMute(ctx, true);
  }

  /** HID2 mute feature on a device driven in telephony mode. */
  onHeldMuteState(ctx, value) {
    const dev = ctx.device;
    if (dev.held === Held.UNSUPPORTED) {
      this.error('Failed to handle HID2 mute in standard mode');
      return;
    }
    if (value === 2 || ctx.callState === CallState.HELD) this.requestMuteState(HELD_MUTE_POLL_MS);

    switch (dev.held) {
      case Held.MUTE_PENDING:
        if (ctx.callState !== CallState.HELD) dev.held = Held.IDLE;
        else if (value === 2) dev.held = Held.MUTED;
        else if (dev.pollCount >= 2) dev.held = Held.UNSUPPORTED;
        else dev.pollCount++;
        return;
      case Held.MUTE_AGAIN_PENDING:
      case Held.UNMUTE_PENDING: {
        const settled = dev.held === Held.MUTE_AGAIN_PENDING ? value === 2 : value === 0;
        if (!settled && !dev.pollCount) {
          dev.pollCount = 1;
          return;
        }
        dev.held = dev.held === Held.MUTE_AGAIN_PENDING ? Held.MUTED : Held.UNMUTED;
        break;
      }
    }
    dev.pollCount = 0;
    if (value === 0) this.reportMute(ctx, false);
    else if (value === 2) this.reportMute(ctx, true);
  }

  onHid2Enabled(ctx, enabled) {
    const dev = ctx.device;
    if (dev.mode === Mode.NONE) {
      if (enabled) {
        dev.mode = Mode.HID2;
        this.requestMuteState();
        this.connectionResult(ctx, true);
      } else if (dev.caps & Capability.REPLICANT) {
        this.startReplicant(ctx);
      } else if (dev.caps & Capability.TELEPHONY) {
        dev.mode = Mode.TELEPHONY;
        this.connectionResult(ctx, true);
      }
      return;
    }
    if (enabled && dev.mode !== Mode.HID2) {
      if (dev.mode === Mode.REPLICANT) {
        if (ctx.appId) {
          this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, Op.RELEASE, 0));
          ctx.waitingForAppId = false;
        }
        ctx.appId = 0;
      }
      dev.mode = Mode.HID2;
    } else if (!enabled && dev.mode === Mode.HID2) {
      if (dev.caps & Capability.REPLICANT) {
        // Keep honouring the telephony hook until the running call ends.
        if (ctx.leds & LED_OFF_HOOK) dev.telephonyFallback = true;
        this.startReplicant(ctx);
      } else if (dev.caps & Capability.TELEPHONY) {
        dev.mode = Mode.TELEPHONY;
      }
    }
  }

  onReplicant(ctx, appId, op, arg) {
    const dev = ctx?.device;
    const match =
      dev && (appId === 0 ? ctx.waitingForAppId : ctx.appId === appId) ? ctx : null;
    if (!match) {
      // Other applications registered with the headset see their messages too.
      if (dev && ctx.appId && appId !== 0) this.debug(`Ignoring opcode ${op} for app ID ${appId}`);
      else this.error(`Failed to handle opcode ${op}: valid context not found`);
      return;
    }

    switch (op) {
      case Op.APP_ID:
        if (!ctx.waitingForAppId) return;
        ctx.waitingForAppId = false;
        ctx.appId = arg;
        this.connectionResult(ctx, true);
        return;
      case Op.REREGISTER:
        ctx.waitingForAppId = false;
        ctx.appId = 0;
        this.platform.sendDelayed(
          Slot.REPLICANT,
          Uint8Array.of(0, Op.APP_ID, 0),
          this.platform.random() % REREGISTER_MAX_DELAY_MS,
          () => {
            ctx.waitingForAppId = true;
          }
        );
        return;
      case Op.FALLBACK:
        if (ctx.waitingForAppId) {
          // The headset declined the app ID request and names a fallback.
          ctx.waitingForAppId = false;
          if (arg === Mode.HID2) {
            dev.mode = Mode.HID2;
            this.connectionResult(ctx, true);
            dev.pollCount = 0;
            this.requestMuteState();
          } else if (arg === Mode.TELEPHONY && dev.link === Link.CONNECTING) {
            dev.mode = Mode.TELEPHONY;
            this.connectionResult(ctx, true);
          } else {
            this.connectionResult(ctx, false);
          }
        } else if (arg === 3) {
          this.emit(ctx, SdkEvent.DISCONNECT);
          dev.mode = Mode.NONE;
        }
        return;
      case Op.PING:
        this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, Op.PING, 0));
        return;
      case Op.RELEASE:
        dev.mode = Mode.NONE;
        ctx.appId = 0;
        return;
      case Op.HOOK:
        if (!dev.legacyHookActive && arg <= 1) this.onHook(ctx, arg, true);
        return;
      case Op.MUTE:
        if (dev.mode !== Mode.HID2 && arg <= 1) this.reportMute(ctx, arg === 1);
        return;
      case Op.FLASH:
        this.onButton(ctx, Slot.FLASH, arg, true);
        return;
      case Op.REDIAL:
        this.onButton(ctx, Slot.REDIAL, arg, true);
        return;
      case Op.REJECT:
        this.onButton(ctx, Slot.REJECT, arg, true);
        return;
      case Op.HOLD:
        this.onButton(ctx, Slot.HOLD, arg, true);
        return;
      default:
        if (!ctx.waitingForAppId) return;
        this.error(`Received unrecognized opcode ${op} while waiting for app ID response, failing connection`);
        ctx.waitingForAppId = false;
        this.connectionResult(ctx, false);
    }
  }

  // ---------------------------------------------------------------- outputs

  sendIndicator(ctx, telephonySlot, hid2Slot, op, on, hid2Value = on) {
    switch (ctx.device.mode) {
      case Mode.TELEPHONY:
        this.platform.send(telephonySlot, Uint8Array.of(on));
        break;
      case Mode.HID2:
        this.platform.send(hid2Slot, Uint8Array.of(hid2Value));
        break;
      case Mode.REPLICANT:
        this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, op, on));
        break;
    }
  }

  sendOffHook(ctx, on, delay) {
    const dev = ctx.device;
    switch (dev.mode) {
      case Mode.TELEPHONY:
        this.platform.sendDelayed(Slot.HOOK_SWITCH, Uint8Array.of(on), delay);
        break;
      case Mode.HID2:
        this.sendHid2OffHook(on, delay);
        break;
      case Mode.REPLICANT:
        this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, Op.HOOK, on));
        if (!on) dev.telephonyFallback = false;
        break;
    }
  }

  sendHid2OffHook(on, delay) {
    this.platform.sendDelayed(Slot.HID2_OFF_HOOK, Uint8Array.of(on), delay);
    this.platform.send(Slot.HID2_CALL_ACTIVE, Uint8Array.of(on ? 1 : 2));
  }

  sendMute(ctx, mute) {
    switch (ctx.device.mode) {
      case Mode.TELEPHONY:
        this.platform.send(Slot.PHONE_MUTE, Uint8Array.of(mute));
        break;
      case Mode.HID2:
        if (ctx.lastMute !== mute) this.platform.send(Slot.HID2_MUTE, Uint8Array.of(mute ? 2 : 1));
        break;
      case Mode.REPLICANT:
        this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, Op.MUTE, mute));
        break;
    }
  }

  // ---------------------------------------------------------------- helpers

  releaseDevice(ctx) {
    if (ctx.device.mode === Mode.REPLICANT && ctx.appId) {
      this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, Op.RELEASE, 0));
      ctx.waitingForAppId = false;
    }
    ctx.appId = 0;
    ctx.device = null;
    return this.platform.disconnect();
  }

  startReplicant(ctx) {
    ctx.device.mode = Mode.REPLICANT;
    ctx.waitingForAppId = true;
    this.platform.send(Slot.REPLICANT, Uint8Array.of(ctx.appId, Op.APP_ID, 0));
  }

  requestMuteState(delay = 0) {
    if (delay) this.platform.sendDelayed(Slot.HID2_MUTE_STATE, new Uint8Array(0), delay);
    else this.platform.send(Slot.HID2_MUTE_STATE, new Uint8Array(0));
  }

  /** True when HID2 mute must be confirmed while HELD in telephony mode. */
  tracksHeldMute(dev) {
    return dev.held !== Held.UNSUPPORTED && dev.mode === Mode.TELEPHONY && (dev.caps & Capability.HID2) !== 0;
  }

  /** Raises MUTE/UNMUTE only when it differs from what was last reported. */
  reportMute(ctx, muted) {
    const mute = muted ? 1 : 0;
    if (ctx.lastMute === mute) return;
    ctx.lastMute = mute;
    this.emit(ctx, muted ? SdkEvent.MUTE : SdkEvent.UNMUTE);
  }

  connectionResult(ctx, success) {
    const dev = ctx.device;
    this.platform.confirmConnection();
    if (dev.link !== Link.CONNECTING) return;
    dev.link = success ? Link.CONNECTED : Link.FAILED;
    this.emit(ctx, success ? SdkEvent.CONNECT_SUCCESS : SdkEvent.CONNECT_FAILED);
  }

  connectedContext(operation) {
    const ctx = this.context;
    const dev = ctx?.device;
    if (!dev || dev.link !== Link.CONNECTED || dev.mode === Mode.NONE) {
      this.error(`${operation}: the device is not connected`);
      return null;
    }
    return ctx;
  }

  emit(ctx, event) {
    if (typeof ctx.handler === 'function') ctx.handler(event);
  }

  error(message) {
    this.platform.log(LogLevel.ERROR, message);
  }

  debug(message) {
    this.platform.log(LogLevel.DEBUG, message);
  }
}

function newContext() {
  return {
    handler: null,
    callState: CallState.IDLE,
    leds: 0,
    lastMute: 0,
    appId: 0,
    waitingForAppId: false,
    device: null,
  };
}

function newDevice() {
  return {
    link: Link.CONNECTING,
    caps: 0,
    mode: Mode.NONE,
    telephonyFallback: false,
    legacyHookActive: false,
    pollCount: 0,
    held: Held.IDLE,
  };
}
