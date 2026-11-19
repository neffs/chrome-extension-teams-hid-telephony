import { VendorImplementation } from 'softphone-vendor-headsets/dist/es/src/library/services/vendor-implementations/vendor-implementation';

const matchesDevice = (device) => device.vendorId === 0x291a && device.productId === 0x3308;

export default class AnkerService extends VendorImplementation {
    constructor(config) {
        super({ ...config, vendorName: 'Anker PowerConf S330' });
        this.device = null;
        this.conversationId = null;
        this.ringing = false;
        this.callActionPending = false;
        this.writeQueue = Promise.resolve();
        this.generation = 0;
        this.handleInput = this.handleInput.bind(this);
        this.handleDisconnect = (event) => {
            if (event.device === this.device) {
                this.device.removeEventListener('inputreport', this.handleInput);
                this.device = null;
                this.changeConnectionStatus({ isConnected: false, isConnecting: false });
            }
        };
        this.handleConnect = (event) => {
            if (matchesDevice(event.device)) this.connect().catch(this.logger.error);
        };
    }

    isSupported() { return Boolean(navigator.hid); }
    get isDeviceAttached() { return Boolean(this.device?.opened); }
    get deviceInfo() { return this.device ? { ProductName: this.device.productName } : null; }
    deviceLabelMatchesVendor(label) { return /\bPowerConf\s+S330\b/i.test(label || ''); }

    async connect() {
        const generation = ++this.generation;
        this.changeConnectionStatus({ isConnected: false, isConnecting: true });
        navigator.hid.addEventListener('disconnect', this.handleDisconnect);
        navigator.hid.addEventListener('connect', this.handleConnect);
        const attach = async (devices) => {
            const device = devices.find(matchesDevice);
            if (generation !== this.generation) return;
            if (!device) {
                this.changeConnectionStatus({ isConnected: false, isConnecting: false });
                return;
            }
            try {
                if (!device.opened) await device.open();
                if (generation !== this.generation) {
                    await device.close();
                    return;
                }
                this.device = device;
                device.addEventListener('inputreport', this.handleInput);
                await this.sendReport(4, 0);
                await this.sendReport(6, 0);
                this.isMuted = false;
                this.changeConnectionStatus({ isConnected: true, isConnecting: false });
            } catch (error) {
                await this.disconnect();
                throw error;
            }
        };
        try {
            const devices = await navigator.hid.getDevices();
            if (devices.some(matchesDevice)) {
                await attach(devices);
            } else {
                this.requestWebHidPermissions(async () => {
                    try {
                        await attach(await navigator.hid.requestDevice({
                            filters: [{ vendorId: 0x291a, productId: 0x3308 }],
                        }));
                    } catch (error) {
                        if (generation === this.generation) {
                            this.changeConnectionStatus({ isConnected: false, isConnecting: false });
                        }
                        throw error;
                    }
                });
            }
        } catch (error) {
            this.changeConnectionStatus({ isConnected: false, isConnecting: false });
            throw error;
        }
    }

    sendReport(reportId, value) {
        const device = this.device;
        const payload = new Uint8Array(12);
        payload[0] = value;
        const write = this.writeQueue.then(() => {
            if (!device?.opened || device !== this.device) throw new Error('S330 disconnected');
            return device.sendReport(reportId, payload);
        });
        this.writeQueue = write.catch(() => {});
        return write;
    }

    handleInput(event) {
        if (event.reportId !== 2 || !event.data.byteLength || !this.conversationId) return;
        const value = event.data.getUint8(0);
        if (value & 2) {
            if (this.callActionPending) return;
            this.callActionPending = true;
            const body = { conversationId: this.conversationId };
            if (this.ringing) {
                // The service treats deviceAnsweredCall as confirmation that the
                // hardware is already off-hook, and skips a subsequent answerCall.
                this.answerCall(body.conversationId)
                    .then(() => {
                        if (this.conversationId === body.conversationId) {
                            this.deviceAnsweredCall(body);
                        }
                    })
                    .catch(error => {
                        this.callActionPending = false;
                        this.logger.error(error);
                    });
            } else {
                this.endAllCalls().catch(error => this.logger.error(error));
                this.deviceEndedCall(body);
            }
            return;
        }
        const muted = Boolean(value & 8);
        if (muted !== this.isMuted) {
            this.isMuted = muted;
            this.deviceMuteChanged({ isMuted: muted });
        }
    }

    async incomingCall({ conversationId }) {
        this.conversationId = conversationId;
        this.ringing = true;
        this.callActionPending = false;
        await this.sendReport(3, 1);
    }

    async outgoingCall({ conversationId }) {
        this.conversationId = conversationId;
        this.ringing = false;
        this.callActionPending = true;
        try {
            await this.sendReport(3, 0);
            await this.sendReport(6, 2);
            await this.setMute(false);
        } finally {
            this.callActionPending = false;
        }
    }

    async answerCall(conversationId) { await this.outgoingCall({ conversationId }); }
    async rejectCall() { await this.endAllCalls(); }
    async endCall() { await this.endAllCalls(); }
    async endAllCalls() {
        this.conversationId = null;
        this.ringing = false;
        this.callActionPending = false;
        await this.sendReport(3, 0);
        await this.setMute(false);
        await this.sendReport(6, 0);
    }

    async setMute(muted) {
        await this.sendReport(4, muted ? 1 : 0);
        this.isMuted = muted;
    }
    async setHold(conversationId, held) { await this.sendReport(5, held ? 1 : 0); }

    async disconnect() {
        ++this.generation;
        navigator.hid.removeEventListener('disconnect', this.handleDisconnect);
        navigator.hid.removeEventListener('connect', this.handleConnect);
        const device = this.device;
        device?.removeEventListener('inputreport', this.handleInput);
        try {
            if (device?.opened) await this.endAllCalls();
        } finally {
            this.device = null;
            this.conversationId = null;
            if (device?.opened) await device.close();
            this.changeConnectionStatus({ isConnected: false, isConnecting: false });
        }
    }
}
