/**
 * Pure JavaScript drop-in replacement for HP's WebAssembly based
 * `call_control_sdk.js`, exposing the same API (`CallControlSdk`, `CallState`,
 * `SdkEvent`). Wired in through webpack's NormalModuleReplacementPlugin.
 */
import { CallControlEngine, CallState, LogLevel, SdkEvent } from './engine.js';
import { BleTransport, GATT_SERVICE_UUID, HidTransport, SUPPORTED_VENDOR_IDS, createLogger } from './transports.js';

export { CallState, SdkEvent, LogLevel };

/** Routes engine calls to whichever transport the current headset uses. */
class Platform {
  constructor() {
    const log = createLogger(() => CallControlSdk.logLevel);
    this.log = log;
    this.hid = new HidTransport(log);
    this.ble = new BleTransport(log);
    this.active = this.hid;
    this.pending = null;
  }

  attach(engine) {
    this.hid.engine = engine;
    this.ble.engine = engine;
  }

  connect(onResult, bluetooth) {
    const device = this.pending;
    this.pending = null;
    if (this.active !== (bluetooth ? this.ble : this.hid)) this.active.disconnect();
    this.active = bluetooth ? this.ble : this.hid;
    return this.active.connect(device, onResult);
  }

  disconnect() {
    return this.active.disconnect();
  }

  retryConnect() {
    return this.active.retryConnect();
  }

  confirmConnection() {
    this.active.confirmConnection();
  }

  send(slot, data) {
    this.active.send(slot, data);
  }

  sendDelayed(slot, data, delayMs, before) {
    this.active.sendDelayed(slot, data, delayMs, before);
  }

  random() {
    return this.active.random();
  }
}

let shared = null;

function sharedEngine() {
  if (!shared) {
    const platform = new Platform();
    const engine = new CallControlEngine(platform);
    platform.attach(engine);
    shared = { platform, engine };
  }
  return shared;
}

const isBluetoothDevice = (headset) =>
  headset && headset.gatt !== undefined && typeof headset.id === 'string' && headset.id.length > 0;

/**
 * The default export from the module.
 * Making extra instances of this class is not useful,
 * all instances will talk to the same headset.
 */
export class CallControlSdk {
  /** Minimum level written to the console. */
  static logLevel = LogLevel.ERROR;

  static async load() {
    if (!navigator.hid) {
      console.error('CCSDK: WebHID is not supported in this browser. Unable to load SDK.');
      return false;
    }
    sharedEngine();
    return true;
  }

  /**
   * Connects to a headset. Without an argument the user is asked to pick one.
   *
   * @param {HIDDevice | BluetoothDevice} [headset]
   * @returns {Promise<boolean>} true when the connection attempt was started.
   */
  async connectHeadset(headset) {
    if (!(await CallControlSdk.load())) return false;
    if (!headset) {
      const filters = SUPPORTED_VENDOR_IDS.map((vendorId) => ({ vendorId }));
      [headset] = await navigator.hid.requestDevice({ filters });
    }
    const { platform, engine } = sharedEngine();
    if (typeof HIDDevice !== 'undefined' && headset instanceof HIDDevice) {
      platform.pending = headset;
      return engine.connect(false);
    }
    if (isBluetoothDevice(headset)) {
      platform.pending = headset;
      return engine.connect(true);
    }
    console.warn('CCSDK: Unable to open a headset when one is not selected / defined.');
    return false;
  }

  /**
   * Connects to a Bluetooth LE headset. Without an argument the user is asked to pick one.
   *
   * @param {BluetoothDevice} [headset]
   * @returns {Promise<boolean>}
   */
  async connectBtHeadset(headset) {
    if (!headset) {
      headset = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [GATT_SERVICE_UUID],
      });
    }
    return headset ? this.connectHeadset(headset) : false;
  }

  /**
   * Disconnect the current headset and free SDK state.
   *
   * @returns {Promise<boolean>} true on success
   */
  async disconnectHeadset() {
    return shared ? shared.engine.disconnect() : false;
  }

  /**
   * Register handler for SDK Events. This must be done before calling connect.
   *
   * @param {(event: number) => void} handler A callback to receive the events from the headset.
   * @returns {Promise<boolean>} true on success.
   */
  async registerEventHandler(handler) {
    if (!(await CallControlSdk.load())) return false;
    return sharedEngine().engine.registerEventHandler(handler);
  }

  /**
   * Informs the headset of the client app's current call state. This needs to be set even if the new state is a result of a SDK Event.
   *
   * @param {number} callState current call state.
   * @returns {Promise<boolean>} true on success
   */
  async setCallState(callState) {
    return shared ? shared.engine.setCallState(callState) : false;
  }

  /**
   * Informs the headset of the client app's current mute state. This needs to be set even if the new state is a result of a SDK Event.
   *
   * @param {boolean} muteState current mute state.
   * @returns {Promise<boolean>} true on success
   */
  async setMuteState(muteState) {
    return shared ? shared.engine.setMuteState(!!muteState) : false;
  }
}

export default CallControlSdk;
