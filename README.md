# Microsoft Teams Webapp Headset HID Call Control

## Overview

Microsoft Teams supports call control natively in the Windows App, but not the browser based version (e.g. on Linux). This Chrome extension implements call control for headsets in the Teams Web App, using the [softphone-vendor-headsets](https://github.com/purecloudlabs/softphone-vendor-headsets) library.

Features:
- Signal incoming calls on headset, accept and reject calls via button
- Busy light on during meetings/calls
- Sync device mute status with Teams mute button

Supported vendors: Jabra, HP/Poly, EPOS/Sennheiser (requires EPOS Connect), Yealink, VBeT and CyberAcoustics. Devices are recognized by their microphone name, so Teams needs microphone access first. Devices working through a dongle or USB are supported; controlling devices connected directly to Bluetooth is not supported.

HP/Poly devices use an own JavaScript implementation of HP's call control SDK (`src/vendor/hp-call-control-sdk`) instead of the WebAssembly build shipped with the library, which cannot run in a content script.

**IMPORTANT NOTE**: You'll need to provide HID permissions to allow the extension to work with your headset. Please click on the extension icon while being on the Teams page to connect.

Tested with |
--- |
Jabra Evolve 60 / Jabra Link 370
Jabra Engage 75
Jabra Evolve2 65
Jabra Evolve 75 SE / Jabra Link 380
...


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
