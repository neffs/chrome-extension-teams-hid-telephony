import { init, SignalType, EasyCallControlFactory, RequestedBrowserTransport, webHidPairing, ErrorType, LogLevel }  from '@gnaudio/jabra-js'

const JABRA_PARTNER_KEY = 'fafd-0b91d5be-f026-4198-b8b4-42685884d7ca';
const JABRA_APP_ID = 'chrome-teams-hid-telephony';
const JABRA_APP_NAME = 'Teams Chrome extension';


/**
 * Initial state
 */
const state = {
    callControlDevices: [],
    currentCallControl: null,
    muteSubscription: null,
    callSubscription: null,
    deviceState: {
      callActive: false,
      muteState: "unmuted",
    },
    endCallInterval: null,
    hangupButtonMissingCounter: 0,
    callStartFlag: false,
  };



const micToggleButton = () => document.getElementById("microphone-button");
const endCallButton = () => document.getElementById("hangup-button");

(async () => {
    chrome.runtime.onMessage.addListener(async function(request, sender, sendResponse) {
        if (request && request.type === 'consent') {
            var consent = document.createElement("div");
            consent.id = 'teamsTelephonyConsentID';
            fetch(chrome.runtime.getURL('/hid_dialog.html'))
                .then(r => r.text())
                .then(html => {
                    consent.innerHTML = html;
                    
                    if (!document.body.classList.contains('teams-telephony-modal-open')) {

                        let ulConnectedDevices = consent.querySelector('#radioTelephonyConnectedDevices');
                        if (state.callControlDevices.length > 0) {
                            ulConnectedDevices.innerHTML = '';
                            state.callControlDevices.forEach(deviceCallControl => {
                                var checked = state.currentCallControl == deviceCallControl ? " checked" : "";
                                var name = deviceCallControl.device.name;
                                var id = deviceCallControl.device.id;
                                ulConnectedDevices.innerHTML += `<input name="teamsTelephonyDevice" type="radio" id="${id}" value="${id}" ${checked} ><label for="${id}">${name}</label><br>`;
                            });
                        }

                        document.body.appendChild(consent);
                        document.body.classList.add('teams-telephony-modal-open');

                        document.getElementById('btnTelephonyDialogHIDRequest').onclick = async (e) => {
                            let connectedDevice = await webHidPairing();
                            if (connectedDevice) {
                                document.body.removeChild(consent);
                                document.body.classList.remove('teams-telephony-modal-open');
                            }
                        };
            
                        document.getElementById('btnTeamsTelephonyDialogClose').onclick = (e) => {
                            document.body.removeChild(consent);
                            document.body.classList.remove('teams-telephony-modal-open');
                        };
                        document.getElementsByName("teamsTelephonyDevice").forEach(element => {
                            element.onclick = async (e) => {
                                useDevice(deviceForID(element.value))
                            }
                        });
                    }
                });
        }
        sendResponse(true);
    });

    const jabra = await init({
        transport: RequestedBrowserTransport.CHROME_EXTENSION_WITH_WEB_HID_FALLBACK,
        partnerKey: JABRA_PARTNER_KEY,
        appId: JABRA_APP_ID,
        appName: JABRA_APP_NAME,
        logger: {
            write(logEvent) {
                if (logEvent.level === LogLevel.ERROR) { // ERROR
                    console.log(logEvent.message, logEvent.layer);
                }
                // Ignore messages with other log levels
            }
        }
    });

    const eccFactory = new EasyCallControlFactory(jabra);

    function deviceForID(id) {
        id = id.toString()
        const index = state.callControlDevices.findIndex((d) =>
            d.device.id.toString() == id
          );
        return state.callControlDevices[index];
    }

    async function useDevice(device) {
        var muteStatus = state.deviceState.muteState;
        var callStatus = state.deviceState.callActive;
        if (state.currentCallControl && state.currentCallControl !== device) {
            if (callStatus) {
                state.currentCallControl.endCall();
            }
        }
        chrome.runtime.sendMessage({deviceConnected: false});

        state.currentCallControl = device;
        if (state.currentCallControl) {
            await addDeviceCallControl(state.currentCallControl);
            chrome.runtime.sendMessage({deviceConnected: true});
        }
  
        
    }
    /**
     * Subscribe to device attach events
     */
    jabra.deviceAdded.subscribe(async (d) => {
        // Skip devices that do not support call control
        if (!eccFactory.supportsEasyCallControl(d)) {
          return;
        }
  
        // Convert the ISdkDevice to a ICallControlDevice
        const ccDevice = await eccFactory.createSingleCallControl(d);
        state.callControlDevices.push(ccDevice);
        useDevice(ccDevice)
        //updateUiBasedOnDeviceInfo();
      });
  
      /**
       * Subscribe to device detach events
       */
      jabra.deviceRemoved.subscribe((removed) => {
        const index = state.callControlDevices.findIndex((d) =>
          d.device.id.equals(removed.id)
        );
        const removedDevice = state.callControlDevices[index];
        if (removedDevice == state.currentCallControl.device) {
            state.currentCallControl = null;
            chrome.runtime.sendMessage({deviceConnected: false});
            setBestDevice();
        }
  
        if (index > -1) {
          state.callControlDevices.splice(index, 1);
          //updateUiBasedOnDeviceInfo();
        } else {
          console.info(
            `Device removed event was not processed, as the removed device (${removed.name}) does not support easy call control.`,
            "warn"
          );
        }
      });
    function setBestDevice() {
        if (state.callControlDevices.length >= 1) {
            useDevice(state.callControlDevices[0])
        }
    }
  
    async function addDeviceCallControl(deviceCallControl) {
        state.muteSubscription?.unsubscribe();
        state.callSubscription?.unsubscribe();
      
        state.callSubscription = deviceCallControl.callActive.subscribe(
            (callState) => {
                console.info("callState: "+callState);
                state.deviceState.callActive=callState;
                if (!callState) {
                    var button=endCallButton();
                    if (button) {
                        button?.click();
                        console.info("clicking hangup button");
                    }
                }
            }
        );
        state.muteSubscription = deviceCallControl.muteState.subscribe(
            (muteState) => {
                console.info("muteState: "+muteState)
                state.deviceState.muteState=muteState;
                var button = micToggleButton();
                if (state.callStartFlag) {
                    // on first callback, ignore value from headset and apply teams status
                    state.callStartFlag=false;
                    if (button?.dataset.state === "mic-off" && muteState === "unmuted") {
                        state.currentCallControl.mute();
                    }
                    if (button?.dataset.state === "mic" && muteState === "muted") {
                        state.currentCallControl.unmute();
                    }
                }
                else {
                    switch (muteState) {
                        case "unmuted":
                            
                            if (button?.dataset.state === "mic-off") {
                                console.info("unmuted");
                                button?.click();
                            }
                            break;
                        
                        case "muted":
                            var button = micToggleButton();
                            if (button?.dataset.state === "mic") {
                                console.info("muted");
                                button?.click();
                            }
                            break;
                    }
                }
            }
        );

        


    }

    function startMonitorCallEnd() {
        if (state.endCallInterval == null) {
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
        if (!state.deviceState.callActive) {
            console.info("ending hangup button monitoring, no call active")
            endMonitorCallEnd();
        }
        else if (!endCallButton()) {
            if (state.hangupButtonMissingCounter>2) {
                console.info("ending call, because no hangup button is found")
                endMonitorCallEnd();
                state.currentCallControl.endCall();
                state.deviceState.callActive=false;
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


    const callStartObserver = new MutationObserver(async (changes) => {
        for (let change of changes) {
            // if (change.target.classList.contains('google-material-icons')) {
            const hangup = endCallButton();
            for (let node of change.addedNodes) {
                // console.warn("new node: "+node+" element id "+node.id)    
                if (node.nodeType === Node.ELEMENT_NODE && node.id == 'call-duration-custom') {
                    if (!state.deviceState.callActive) {
                        console.info("ongoing call detected, starting call");
                        // save mute status, because headset might unmute
                        var doMute = micToggleButton()?.dataset.state === "mic-off"
                        state.currentCallControl.startCall();
                        state.callStartFlag=true;
                        state.deviceState.callActive=true;
                        if (doMute) {
                            console.info("mute device, from teams status")
                            state.currentCallControl.mute()
                        }
                        // detect hangup
                        startMonitorCallEnd();

                    }
                }
                else {
                    if (node.nodeType === Node.ELEMENT_NODE && node.dataset.testid == "notification-wrapper-backplate") {
                        console.info("incoming call detected");
                        // set up callbacks to react to changes in Teams, either accept buttons are clicked, or the notification disappears
                        // Observe call notification wrapper, it might disappear, e.g. when caller stops calling.
                        const observercallback = function(mutationsList, observer) {
                            for (let mutation of mutationsList) {
                                if (mutation.type === 'childList') {
                                    for (let node of mutation.removedNodes) {
                                        if (node.nodeType === Node.ELEMENT_NODE && node.dataset.testid == "notification-wrapper-backplate") {
                                            console.info("call notification disappeared")
                                            state.currentCallControl.rejectIncomingCall();
                                            observer.disconnect()
                                        }
                                    }
                                }
                            }
                        };
                        const observer = new MutationObserver(observercallback);
                        observer.observe(node.parentNode, {childList:true, subtree: true})

                        // Add event handlers to buttons
                        const buttons = node.querySelector('[data-testid="calling-actions"]').querySelectorAll("button");
                        const accepthandler = function() {observer.disconnect();state.currentCallControl.acceptIncomingCall();};
                        const acceptvideobutton=buttons[0];
                        const acceptvoicebutton=buttons[1];
                        acceptvoicebutton.addEventListener("click", accepthandler);
                        acceptvideobutton.addEventListener("click", accepthandler);
                        // const rejecthandler = function() {observer.disconnect();state.currentCallControl.rejectIncomingCall();};
                        const rejectbutton=buttons[2];
                        // rejectbutton.addEventListener("click", rejecthandler)
                        // Let Headset ring
                        // this blocks code execution until call is accepted or rejected
                        const response = await state.currentCallControl.signalIncomingCall();
                        const message = response ? "Call accepted" : "Call rejected";
                        if (response) {
                            // dont wait for callback, set to true now
                            state.callActive=true;
                        }
                        // Remove Listener before clicking button, because handler would accept/reject again.
                        acceptvoicebutton.removeEventListener("click", accepthandler)
                        acceptvideobutton.removeEventListener("click", accepthandler)
                        // rejectbutton.removeEventListener("click", rejecthandler)
                        observer.disconnect()
                        // click teams button, if it still exists
                        const chosenbutton = response ? acceptvoicebutton : rejectbutton;
                        if (chosenbutton) {
                            chosenbutton?.click();
                            console.info(message+", clicked button: "+chosenbutton.ariaLabel);
                        }
                        // hangup button is still missing at this stage, start monitoring after 3 seconds
                        if (response) {
                            window.setTimeout(startMonitorCallEnd, 3000);
                        }
                    }
                    
                }
            }
            // }
            
        }
    });
    callStartObserver.observe(document.body, {
        subtree: true,
        childList: true,
    });


    const muteObserver = new MutationObserver((changes) => {
        for (const change of changes) {
            if (change.target === micToggleButton() && change.attributeName === 'aria-label') {
                if (change.target.dataset.state === 'mic') {
                    try {
                        state.currentCallControl.unmute()
                    }
                    catch (err) {
                        console.error(err);
                    }
                }
                else {
                    try {
                        state.currentCallControl.mute()
                    }
                    catch (err) {
                        console.error(err);
                    }
                }
                return;
            }
        }
    });
    muteObserver.observe(document.body, {
        attributes: true,
        subtree: true,
    });

    window.addEventListener('beforeunload', function () {
        if (state.deviceState.callActive) {
            state.currentCallControl.endCall();
        }
    });

})();