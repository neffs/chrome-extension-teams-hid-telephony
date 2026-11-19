import HeadsetService from 'softphone-vendor-headsets';
import AnkerService from './anker';

export default class ExtendedHeadsetService extends HeadsetService {
    constructor(config) {
        super(config);
        this.anker = new AnkerService(config);
        this.subscribeToHeadsetEvents(this.anker);
    }

    static getInstance(config) {
        if (!this.extendedInstance) this.extendedInstance = new ExtendedHeadsetService(config);
        return this.extendedInstance;
    }

    get implementations() {
        const implementations = super.implementations;
        if (this.anker?.isSupported()) implementations.push(this.anker);
        return implementations;
    }
}
