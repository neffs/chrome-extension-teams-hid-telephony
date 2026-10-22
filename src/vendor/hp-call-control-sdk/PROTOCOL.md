# HP / Poly headset call-control protocol

Interoperability notes behind the pure JavaScript call-control implementation in
this folder (`engine.js`, `transports.js`, `call_control_sdk.js`). They describe
what goes over the wire and how the headset expects to be driven. They were
gathered by observing HP's shipped SDK at its platform boundary, with its
decoded WebAssembly consulted only for exact predicates. No HP code is included.

## Transports and capabilities

USB / dongle devices go through WebHID. Supported vendor IDs are `0x047F`,
`0x095D` and `0x03F0`. Each top-level collection adds a capability:

| Usage page | Capability | Bit  |
|------------|------------|------|
| `0x000B`   | Telephony  | 1    |
| `0xFFA2`   | HID2       | 2    |
| `0xFF1B`   | Replicant  | 4    |
| `0xFFA0`   | Legacy     | 16 (dropped when HID2 is present) |

Bluetooth LE devices use GATT service `23c1b9c0-4e04-4a93-91c3-b85e32a5f7b7`.
Notifications arrive on `…f7d7`, writes go to `…f7c7` (with response; retried on
"already in progress"). BLE only carries Replicant messages.

Input fields are reported only when their value changes, except Replicant
messages and feature reads. If no mode is confirmed within 10 s of opening, the
connection fails.

## Mode selection

1. HID2 present: read feature `0xFFA2:0x8F`. A non-zero value selects **HID2
   mode**. Zero falls back to Replicant, then Telephony.
2. Replicant present: send `[appId=0, 0, 0]` and wait for `[0, 0, newAppId]`.
3. Telephony present: **Telephony mode**, confirmed immediately.

Input `0xFFA2:0x8F` re-reads the feature, so a headset can switch modes at
runtime. Indicator state carries over between modes.

## Indicators (application → headset)

| Call state       | ring | off-hook | hold |
|------------------|------|----------|------|
| IDLE             |      |          |      |
| INCOMING         | ✓    |          |      |
| OUTGOING, ACTIVE |      | ✓        |      |
| ACTIVE_AND_INCOMING | ✓ | ✓        |      |
| ACTIVE_AND_HELD  |      | ✓        | Replicant only |
| HELD             |      | HID2 only (not re-sent) | ✓ |

Only changes are sent, in the order ring, hold, off-hook. In Telephony and HID2
mode, off-hook goes out after a 2 ms delay when another indicator changed in the
same update (0 ms otherwise). HID2 re-sends off-hook every time ACTIVE is
entered.

| Indicator | Telephony (LED page)  | HID2 (`0xFFA2`)                          | Replicant op |
|-----------|-----------------------|------------------------------------------|--------------|
| off-hook  | `0x08:0x17`           | `0xDC` = v, then `0x54` = 1 on / 2 off   | 10           |
| mute      | `0x08:0x09`           | `0xB5` = 2 mute / 1 unmute               | 11           |
| ring      | `0x08:0x18`           | `0x9E`                                   | 15           |
| hold      | `0x08:0x20`           | `0x22` = 1 held / 2 released             | 16           |

## Buttons (headset → application)

| Function | Telephony               | HID2            | Legacy (`0xFFA0`) | Replicant op |
|----------|-------------------------|-----------------|-------------------|--------------|
| hook     | `0x0B:0x20`             | `0xB7`, `0x61`  | `0xB7`            | 10           |
| mute     | `0x0B:0x2F`             | via feature `0xB5` | –              | 11           |
| flash    | `0x0B:0x21`             | `0xB3`          | `0xB3`            | 12           |
| redial   | `0x0B:0x24`             | –               | –                 | 13           |
| reject   | `0x0B:0x07`, `0x09:0x07` | `0xDD`         | –                 | 14           |
| hold     | –                       | –               | –                 | 16 (1 hold, 0 resume) |

- A value of `1` counts as pressed. An absolute hook switch reports its level:
  `1` while INCOMING raises ANSWER, and `0` during OUTGOING / ACTIVE / ACTIVE_* raises
  TERMINATE. A relative hook switch toggles on each press.
- Reject only fires while INCOMING or ACTIVE_AND_INCOMING.
- After the legacy hook has been used once, the telephony hook and flash are
  ignored.
- MUTE / UNMUTE are raised only when they differ from what was last reported or
  set via `setMuteState`. A relative mute button toggles the indicator state.

## HID2 mute

The headset owns the mute state. Input `0xFFA2:0x9C` requests a read of feature
`0xFFA2:0xB5`, whose value means: `0` unmuted, `2` muted, `1` / `3` still changing
(unmuted / muted), anything else unknown. Values other than 0 and 2 are re-read
after 200 ms, at most 25 times.

When HID2 is present but disabled (Telephony mode), the same feature is polled
every 500 ms while HELD, or while it reads `2`. A mute change requested while
HELD must be confirmed within three reads; otherwise the feature is ignored for
the rest of the connection.

## Replicant messages

Each message is `[appId, op, arg]`. `appId` 0 is only valid during the
handshake.

| op | Direction | Meaning |
|----|-----------|---------|
| 0  | ⇄ | app-ID request `[0,0,0]` / grant `[0,0,id]` |
| 1  | ← | re-register: request a new app ID after a random 0–5 s delay |
| 2  | ← | while registering: fallback (`1` Telephony, `2` HID2, other → fail); otherwise `3` = headset disconnected |
| 3  | ⇄ | ping, answered with `[id,3,0]` |
| 4  | ⇄ | release the app ID (sent on disconnect or switch to HID2) |
| 10–16 | ⇄ | hook, mute, flash, redial, reject, ring, hold (see tables) |

Any other opcode during registration fails the connection.

## Lifecycle

- `connect` while a connection is in progress raises CONNECT_FAILED and returns
  false. Reconnecting keeps the indicator state but resets the call state.
- Unplugging a connected device raises DISCONNECT. If the device only offered
  HID2, a reconnect by product name is attempted after 1.5 s instead.
- `disconnectHeadset` releases the device and clears all state except the
  event handler.

### Deliberate deviations from HP's SDK

- HID report fields after constant (padding) items are located correctly.
- A HID2 reconnect that cannot find the device, or a confirmation timeout on a
  HID2-only headset, raises CONNECT_FAILED / DISCONNECT instead of leaving the
  connection pending forever.
- Replicant messages addressed to another application's app ID (other clients
  registered with the same headset) are logged at debug level instead of as an
  error.
