import HeadsetService from 'softphone-vendor-headsets';

const APP_NAME = 'Teams Chrome extension';

/**
 * Initial state
 */
const state = {
    // microphone labels of attached headsets supported by one of the vendor implementations
    supportedLabels: [],
    selectedLabel: null,
    connectionStatus: 'noVendor',
    // set when a vendor implementation needs a user gesture to request WebHID access
    pendingPermissionCallback: null,
    conversationId: null,
    callActive: false,
    // after a call ended, wait until the call UI is gone before detecting a new call
    callUiMustDisappear: false,
    incomingCall: null,
    endCallInterval: null,
    hangupButtonMissingCounter: 0,
};

/**
 * Settings, changed in the dialog and kept in chrome.storage.local
 */
const settings = {
    // select the headset as Teams microphone and speaker on every call, not only on calls answered on the headset
    alwaysUseHeadsetAudio: false,
};
chrome.storage.local.get(settings)
    .then((stored) => Object.assign(settings, stored))
    .catch(console.error);
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
        return;
    }
    for (const [key, { newValue }] of Object.entries(changes)) {
        if (key in settings) {
            settings[key] = newValue;
        }
    }
});

// The library logs a lot on debug level, only pass on the rest
const logger = {
    debug() {},
    log: (...args) => console.log(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
};

const headsetService = HeadsetService.getInstance({
    logger,
    appName: APP_NAME,
    // HP/Poly via WebHID instead of the local Poly Hub service
    useNewPolyImplementation: true,
});

const micToggleButton = () => document.getElementById("microphone-button");
const endCallButton = () => document.getElementById("hangup-button");
const teamsIsMuted = () => micToggleButton()?.dataset.state === "mic-off";

const audioOptionsButton = () => document.getElementById("audio-button-configure");

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitFor(find, timeoutMs) {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
        const found = find();
        if (found) {
            return found;
        }
        await sleep(100);
    }
    return find();
}

function newConversationId() {
    return `teams-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function implementationForLabel(label) {
    return headsetService.implementations.find((implementation) => implementation.deviceLabelMatchesVendor(label));
}

/**
 * Collect the labels of all microphones a vendor implementation can handle.
 * Labels are only available once Teams has been granted microphone access.
 */
async function refreshSupportedLabels() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const labels = devices
        // "default" and "communications" are aliases of real devices
        .filter((d) => d.kind === 'audioinput' && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d) => d.label);
    state.supportedLabels = [...new Set(labels)].filter((label) => headsetService.deviceIsSupported({ micLabel: label }));
    return state.supportedLabels;
}

async function useDevice(label) {
    const implementation = implementationForLabel(label);
    if (!implementation) {
        console.warn(`no headset implementation for ${label}`);
        return;
    }
    console.info(`set up headset ${label} (${implementation.vendorName})`);
    state.selectedLabel = label;
    state.pendingPermissionCallback = null;
    chrome.runtime.sendMessage({deviceConnected: false});
    if (implementation === headsetService.selectedImplementation) {
        // same vendor, different device: changeImplementation() would be a no-op
        await implementation.disconnect();
        await headsetService.retryConnection(label);
    } else {
        await headsetService.changeImplementation(implementation, label);
    }
}

async function setBestDevice() {
    const labels = await refreshSupportedLabels();
    if (state.selectedLabel && labels.includes(state.selectedLabel)) {
        return;
    }
    if (labels.length >= 1) {
        await useDevice(labels[0]);
    } else if (state.selectedLabel) {
        console.info(`headset ${state.selectedLabel} removed`);
        state.selectedLabel = null;
        state.pendingPermissionCallback = null;
        headsetService.activeMicChange(null);
    }
}

/**
 * Select the headset as Teams microphone and speaker. Teams only offers this in the
 * audio options flyout next to the mic button, so open it, pick the devices and close it again.
 */
let selectingAudioDevices = false;
async function selectHeadsetAudioDevices() {
    if (!state.selectedLabel || selectingAudioDevices) {
        return;
    }
    selectingAudioDevices = true;
    try {
        const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
        const headsetMic = devices.find((d) => d.kind === 'audioinput' && d.label === state.selectedLabel);
        if (!headsetMic) {
            return;
        }
        // speaker and microphone of one device share the groupId, their labels may differ
        const headsetDevices = devices.filter((d) => d.groupId === headsetMic.groupId
            && (d.kind === 'audioinput' || d.kind === 'audiooutput'));

        // the call UI is still loading right after a call was accepted
        if (!await waitFor(audioOptionsButton, 10000)) {
            console.warn("audio options button not found, cannot select headset audio devices");
            return;
        }
        const wasOpen = audioOptionsButton().getAttribute('aria-expanded') === 'true';
        if (!wasOpen) {
            audioOptionsButton().click();
        }
        for (const device of headsetDevices) {
            const kind = device.kind === 'audioinput' ? 'microphone' : 'speaker';
            const option = await waitFor(() => document.getElementById(`${kind}:${device.deviceId}`), 3000);
            if (!option) {
                console.warn(`Teams ${kind} option for ${device.label} not found`);
            } else if (option.getAttribute('aria-selected') !== 'true') {
                console.info(`selecting ${device.label} as Teams ${kind}`);
                option.click();
            }
        }
        if (!wasOpen && audioOptionsButton()?.getAttribute('aria-expanded') === 'true') {
            audioOptionsButton().click();
        }
    } finally {
        selectingAudioDevices = false;
    }
}

/**
 * Tell the headset about a running call, e.g. after it was (re)connected during a call
 */
async function startCallOnHeadset() {
    await headsetService.outgoingCall({ conversationId: state.conversationId });
    // Teams is the source of truth for the mute state
    await headsetService.setMute(teamsIsMuted());
}

function onConnectionStatusChanged(status) {
    if (status === state.connectionStatus) {
        return;
    }
    console.info("headset connection status: " + status);
    state.connectionStatus = status;
    chrome.runtime.sendMessage({deviceConnected: status === 'running'});
    if (status === 'running') {
        state.pendingPermissionCallback = null;
        if (state.callActive) {
            console.info("start call on new headset");
            startCallOnHeadset().catch(console.error);
        }
    }
    updateDialog();
}

headsetService.headsetEvents$.subscribe(({ event, payload }) => {
    switch (event) {
        case 'deviceConnectionStatusChanged':
            onConnectionStatusChanged(payload);
            break;

        case 'webHidPermissionRequested':
            console.info("headset needs WebHID permission, click the extension icon to connect");
            state.pendingPermissionCallback = payload.callback;
            updateDialog();
            break;

        case 'deviceAnsweredCall':
            if (state.incomingCall?.conversationId === payload.conversationId) {
                const incoming = state.incomingCall;
                finishIncomingCall(incoming);
                incoming.acceptVoiceButton.click();
                console.info("call accepted on headset, clicked button: " + incoming.acceptVoiceButton.ariaLabel);
                callAccepted(incoming.conversationId);
            }
            break;

        case 'deviceRejectedCall':
            if (state.incomingCall?.conversationId === payload.conversationId) {
                const incoming = state.incomingCall;
                finishIncomingCall(incoming);
                incoming.rejectButton.click();
                console.info("call rejected on headset, clicked button: " + incoming.rejectButton.ariaLabel);
            }
            break;

        case 'deviceEndedCall':
            if (state.callActive) {
                state.callActive = false;
                state.callUiMustDisappear = true;
                endMonitorCallEnd();
                const button = endCallButton();
                if (button) {
                    button.click();
                    console.info("clicking hangup button");
                }
            }
            break;

        case 'deviceMuteStatusChanged':
            if (state.callActive && payload.isMuted !== teamsIsMuted()) {
                console.info(payload.isMuted ? "muted" : "unmuted");
                micToggleButton()?.click();
            }
            break;
    }
});

/**
 * Dialog opened via extension icon
 */
function updateDialog() {
    const dialog = document.getElementById('teamsTelephonyConsentID');
    if (!dialog) {
        return;
    }

    const list = dialog.querySelector('#radioTelephonyConnectedDevices');
    if (state.supportedLabels.length > 0) {
        list.replaceChildren();
        state.supportedLabels.forEach((label, index) => {
            const id = `teamsTelephonyDevice${index}`;
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'teamsTelephonyDevice';
            input.id = id;
            input.value = label;
            input.checked = label === state.selectedLabel;
            input.onclick = () => useDevice(label).catch(console.error);
            const labelElement = document.createElement('label');
            labelElement.htmlFor = id;
            labelElement.textContent = label;
            list.append(input, labelElement, document.createElement('br'));
        });
    }

    const statusTexts = {
        running: 'Connected.',
        checking: state.pendingPermissionCallback
            ? 'Click Connect and select the headset in Chrome.'
            : 'Connecting...',
        notRunning: 'Not connected. Click Connect to retry.',
        noVendor: 'No supported headset selected.',
    };
    dialog.querySelector('#teamsTelephonyStatus').textContent = statusTexts[state.connectionStatus] || '';
}

function closeDialog(dialog) {
    dialog.remove();
    document.body.classList.remove('teams-telephony-modal-open');
}

async function showDialog() {
    if (document.body.classList.contains('teams-telephony-modal-open')) {
        return;
    }
    // Teams might have been granted microphone access in the meantime
    await setBestDevice();

    const html = await fetch(chrome.runtime.getURL('/hid_dialog.html')).then(r => r.text());
    const dialog = document.createElement("div");
    dialog.id = 'teamsTelephonyConsentID';
    dialog.innerHTML = html;
    document.body.appendChild(dialog);
    document.body.classList.add('teams-telephony-modal-open');
    updateDialog();

    document.getElementById('btnTelephonyDialogHIDRequest').onclick = async () => {
        const callback = state.pendingPermissionCallback;
        if (callback) {
            // must run directly in the click handler, WebHID requires a user gesture
            state.pendingPermissionCallback = null;
            try {
                await callback();
            } catch (err) {
                console.error(err);
            }
        } else if (state.selectedLabel) {
            await useDevice(state.selectedLabel);
        }
        updateDialog();
        if (state.connectionStatus === 'running') {
            closeDialog(dialog);
        }
    };

    const alwaysUseHeadsetAudio = document.getElementById('chkTeamsTelephonyAlwaysUseHeadsetAudio');
    alwaysUseHeadsetAudio.checked = settings.alwaysUseHeadsetAudio;
    alwaysUseHeadsetAudio.onchange = () => {
        settings.alwaysUseHeadsetAudio = alwaysUseHeadsetAudio.checked;
        chrome.storage.local.set({ alwaysUseHeadsetAudio: settings.alwaysUseHeadsetAudio }).catch(console.error);
        if (settings.alwaysUseHeadsetAudio && state.callActive) {
            selectHeadsetAudioDevices().catch(console.error);
        }
    };

    document.getElementById('btnTeamsTelephonyDialogClose').onclick = () => closeDialog(dialog);
}

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request && request.type === 'consent') {
        showDialog().catch(console.error);
    }
    sendResponse(true);
});

/**
 * Call handling
 */
function callAccepted(conversationId) {
    state.conversationId = conversationId;
    state.callActive = true;
    // hangup button is still missing at this stage, start monitoring after 3 seconds
    window.setTimeout(startMonitorCallEnd, 3000);
    headsetService.answerCall(conversationId)
        .then(() => headsetService.setMute(teamsIsMuted()))
        .catch(console.error);
    if (settings.alwaysUseHeadsetAudio) {
        selectHeadsetAudioDevices().catch(console.error);
    }
}

function finishIncomingCall(incoming) {
    incoming.observer.disconnect();
    incoming.acceptVoiceButton.removeEventListener("click", incoming.acceptHandler);
    incoming.acceptVideoButton.removeEventListener("click", incoming.acceptHandler);
    if (state.incomingCall === incoming) {
        state.incomingCall = null;
    }
}

function handleIncomingCall(node) {
    const buttons = node.querySelector('[data-testid="calling-actions"]')?.querySelectorAll("button");
    if (!buttons || buttons.length < 3) {
        console.warn("incoming call buttons not found");
        return;
    }

    const incoming = {
        conversationId: newConversationId(),
        acceptVideoButton: buttons[0],
        acceptVoiceButton: buttons[1],
        rejectButton: buttons[2],
    };

    // accepted in Teams
    incoming.acceptHandler = () => {
        finishIncomingCall(incoming);
        callAccepted(incoming.conversationId);
    };
    incoming.acceptVoiceButton.addEventListener("click", incoming.acceptHandler);
    incoming.acceptVideoButton.addEventListener("click", incoming.acceptHandler);

    // Observe call notification wrapper, it might disappear, e.g. when caller stops calling or call is rejected in Teams.
    incoming.observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            for (const removed of mutation.removedNodes) {
                if (removed === node || (removed.nodeType === Node.ELEMENT_NODE && removed.contains(node))) {
                    console.info("call notification disappeared");
                    finishIncomingCall(incoming);
                    headsetService.rejectCall(incoming.conversationId).catch(console.error);
                    return;
                }
            }
        }
    });
    incoming.observer.observe(node.parentNode, {childList: true, subtree: true});

    state.incomingCall = incoming;
    // Let headset ring, answer/reject on the headset arrives as event
    headsetService.incomingCall({ conversationId: incoming.conversationId }, state.callActive).catch(console.error);
}

function startMonitorCallEnd() {
    if (state.endCallInterval == null) {
        state.hangupButtonMissingCounter = 0;
        state.endCallInterval = window.setInterval(endCallIfHangupButtonMissing, 500);
    }
}

function endMonitorCallEnd() {
    if (state.endCallInterval) {
        window.clearInterval(state.endCallInterval);
        state.endCallInterval = null;
    }
}

function endCallIfHangupButtonMissing() {
    if (!state.callActive) {
        console.info("ending hangup button monitoring, no call active")
        endMonitorCallEnd();
    }
    else if (!endCallButton()) {
        if (state.hangupButtonMissingCounter>2) {
            console.info("ending call, because no hangup button is found")
            endMonitorCallEnd();
            state.callActive = false;
            state.callUiMustDisappear = true;
            headsetService.endCall(state.conversationId).catch(console.error);
        }
        else {
            console.info("hangup button missing, wait a little more, before ending call")
            state.hangupButtonMissingCounter++;
        }
    }
    else {
        state.hangupButtonMissingCounter=0;
    }
}

/**
 * Check the DOM for a running call instead of waiting for specific nodes to be added,
 * the call UI may be inserted as a whole or already exist when this script loads.
 */
function detectOngoingCall() {
    const callUiPresent = !!(document.getElementById('call-duration-custom') || endCallButton());
    if (!callUiPresent) {
        state.callUiMustDisappear = false;
    }
    if (state.callActive || state.incomingCall || state.callUiMustDisappear) {
        return;
    }
    if (callUiPresent) {
        console.info("ongoing call detected, starting call");
        state.conversationId = newConversationId();
        state.callActive = true;
        startCallOnHeadset().catch(console.error);
        // detect hangup
        startMonitorCallEnd();
        if (settings.alwaysUseHeadsetAudio) {
            selectHeadsetAudioDevices().catch(console.error);
        }
    }
}

const NOTIFICATION_SELECTOR = '[data-testid="notification-wrapper-backplate"]';
const handledNotifications = new WeakSet();

function detectIncomingCalls(node) {
    const notifications = node.matches(NOTIFICATION_SELECTOR) ? [node] : node.querySelectorAll(NOTIFICATION_SELECTOR);
    for (const notification of notifications) {
        if (!handledNotifications.has(notification)) {
            handledNotifications.add(notification);
            console.info("incoming call detected");
            handleIncomingCall(notification);
        }
    }
}

let detectCallScheduled = false;
const callStartObserver = new MutationObserver((changes) => {
    for (const change of changes) {
        for (const node of change.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                detectIncomingCalls(node);
            }
        }
    }
    // Teams mutates the DOM constantly, don't check on every mutation
    if (!detectCallScheduled) {
        detectCallScheduled = true;
        window.setTimeout(() => {
            detectCallScheduled = false;
            detectOngoingCall();
        }, 200);
    }
});
callStartObserver.observe(document.body, {
    subtree: true,
    childList: true,
});
detectOngoingCall();

const muteObserver = new MutationObserver((changes) => {
    for (const change of changes) {
        if (change.target === micToggleButton() && change.attributeName === 'aria-label') {
            const muted = teamsIsMuted();
            console.info("microphone button switched to " + (muted ? "mic-off" : "!=mic-off"));
            // no-op if the headset already has this state
            headsetService.setMute(muted).catch(console.error);
            return;
        }
    }
});
muteObserver.observe(document.body, {
    attributes: true,
    subtree: true,
});

window.addEventListener('beforeunload', function () {
    if (state.callActive) {
        headsetService.endCall(state.conversationId);
    }
});

navigator.mediaDevices.addEventListener('devicechange', () => setBestDevice().catch(console.error));
setBestDevice().catch(console.error);
