/**
 * Wrapper around @gnaudio/jabra-js for softphone-vendor-headsets, which hardcodes
 * its own appId/appName and passes no partner key. Wired in through webpack's
 * NormalModuleReplacementPlugin for imports from that library only.
 */
import { init as jabraInit } from '@gnaudio/jabra-js';

export * from '@gnaudio/jabra-js';

const JABRA_PARTNER_KEY = '9be8-af2ca990-a27c-4fff-8f39-408e2a7464d1';
const JABRA_APP_ID = 'chrome-teams-hid-telephony';
const JABRA_APP_NAME = 'Teams Chrome extension';

export function init(config) {
    return jabraInit({
        ...config,
        partnerKey: JABRA_PARTNER_KEY,
        appId: JABRA_APP_ID,
        appName: JABRA_APP_NAME,
    });
}
