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

### Using another Teams hostname

If the extension does not activate on your organization's Teams site, check the site's hostname against the URL patterns in `src/manifest.json`. An exact hostname pattern does not include its subdomains.

1. Add a URL pattern for your Teams hostname to both `content_scripts[0].matches` and `web_accessible_resources[0].matches`. Preserve the existing entries. For example, these additional hostnames have been tested with Microsoft Edge on Windows, including Teams installed as an Edge app.

   ```json
   [
     "https://gov.teams.microsoft.us/*",
     "https://dod.teams.microsoft.us.mcas-gov.us/*"
   ]
   ```

2. Run `npm run build` from the repository directory after installing dependencies.
3. Open `edge://extensions` or `chrome://extensions` and reload the unpacked extension.
4. Refresh Teams, or close and reopen the installed Teams web app. In an installed Edge app, use the title-bar **Settings and more (...) > Extensions** menu to open the headset connection dialog if needed.

Use the exact hostname shown by your Teams site and include `/*` to match its paths. The site must serve a compatible Teams web interface for call control to work.

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
