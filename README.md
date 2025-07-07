# Microsoft Teams Webapp Jabra HID Call Control

## Overview

Microsoft Teams supports call control natively in the Windows App, but not the browser based version (e.g. on Linux). This Chrome extension implements call control for Jabra headsets for the Teams Web App.

Features:
- Signal incoming calls on headset, accept and reject calls via button
- Busy light on during meetings/calls
- Sync device mute status with Teams mute button

Supports devices working through Jabra Link dongle or USB; controlling devices connected directly to Bluetooth is not supported.

**IMPORTANT NOTE**: You'll need to provide HID permissions to allow the extension to work with your Jabra device. Please click on the extension icon while being on the Teams page to connect.

Tested with |
--- |
Jabra Evolve 60 / Jabra Link 370
Jabra Engage 75
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