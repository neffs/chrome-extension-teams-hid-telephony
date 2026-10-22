# Microsoft Teams Webapp Headset HID Call Control

## Overview

The Microsoft Teams desktop app supports the call buttons on your headset, but the browser version does not, for example on Linux or ChromeOS. This Chrome extension brings headset call control to the Teams Web App, using the [softphone-vendor-headsets](https://github.com/purecloudlabs/softphone-vendor-headsets) library.

Features:
- Incoming calls ring on your headset; answer or reject them with the headset buttons
- Hang up from the headset
- Busy light turns on during calls and meetings
- Mute state stays in sync between headset and Teams, in both directions

Supported headsets:
- Jabra
- HP / Poly
- EPOS / Sennheiser (requires EPOS Connect)
- Yealink
- VBeT
- CyberAcoustics

Headsets connected via USB or a USB dongle are supported. Headsets paired directly with your computer's Bluetooth are not.

Tested with |
--- |
Jabra Evolve 60 / Jabra Link 370
Jabra Evolve 75 SE / Jabra Link 380
Jabra Evolve2 65
Jabra Engage 75
Poly BT700 dongle

## Usage

1. Open Teams in Chrome and allow microphone access, so the extension can recognize your headset by its name.
2. The headset connects automatically. If Chrome needs permission to access it, click the extension icon, then "Connect", and select your headset.
3. The icon turns green when the headset is connected.

## Implementation notes

HP/Poly devices use an own JavaScript implementation of HP's call control SDK (`src/vendor/hp-call-control-sdk`, see `PROTOCOL.md` there) instead of the WebAssembly build shipped with the library, which cannot run in a content script. For Jabra, `src/vendor/jabra-js.js` makes the library initialize the Jabra SDK with this extension's app ID and partner key.


## Installing and Running

### Procedures:

1. Install node.js
2. Clone this repository.
3. Run `npm install` to install the dependencies.
4. Run `npm start`
5. Load your extension on Chrome following:
   1. Access `chrome://extensions/`
   2. Check `Developer mode`
   3. Click on `Load unpacked extension`
   4. Select the `build` folder.


## Acknowledgements

This Extension is derived from a similar Extension for Google Meet: https://github.com/balansse/google-meet-jabra
