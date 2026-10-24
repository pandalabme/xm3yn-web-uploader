# XM3YN@ E31A protocol reference

This document records the verified first-version contract for the XM3YN@ E31A yellow panel. It does not define behavior for other models or firmware revisions. The panel is 296 × 152 pixels, with two 5,624-byte image planes.

## GATT identifiers

| Purpose | Service UUID | Characteristic UUID | Required characteristic property |
| --- | --- | --- | --- |
| UART commands | `00001f10-0000-1000-8000-00805f9b34fb` | `00001f1f-0000-1000-8000-00805f9b34fb` | Write |
| EPD commands and image data | `13187b10-eba9-a3ba-044e-83d3217d9a38` | `4b646063-6264-f3a7-8941-e65356ea82fe` | Write and Notify |

Look up services and characteristics by complete UUID. Do not rely on a browser or BLE utility's display order or labels.

## Known commands

All bytes below are hexadecimal. Use Write Request (`writeValueWithResponse`) for known commands, matching the verified Macro path.

| Operation | Characteristic | Bytes | Verified meaning |
| --- | --- | --- | --- |
| Enter image mode | UART | `E1 00` | Enter image receive mode |
| Clear buffers | EPD | `00 00` | Clear both color plane buffers |
| Reset image offset | EPD | `02 00 00` | Reset image write position |
| Write image data | EPD | `03 PP HH LL DATA...` | Write data to a selected plane and absolute offset |
| Refresh display | EPD | `01 01` | Refresh the full display |

For image packets, `PP` is `FF` for the black/white plane and `00` for the yellow plane. `HH LL` is the 16-bit absolute offset in big-endian order. `DATA` contains image bytes. Do not infer other selectors, commands, offsets, or response behavior.

`00 FF` is not a verified full-white operation for this device. On the 2026-10-22 XM3YN@ E31A test, sending `00 FF` followed by `01 01` produced a yellow screen. The earlier “white buffer” label is therefore rejected; do not expose it as a white-screen command or use it as a health check.

## Handshake and acknowledgements

After service discovery, verify EPD Notify and subscribe to notifications. Write `E1 00` to UART, then write the no-image-payload probe `03 FF 00 00` to EPD. The device must notify `00 04`; `04` is the total length of that probe packet. Only then mark the connection ready. The probe's no-screen-change behavior should be confirmed on the target device before relying on it in a release.

Each `03` data packet is acknowledged by a two-byte notification containing the total packet length. For example, a 20-byte safe packet is acknowledged as `00 14`, while a 244-byte fast packet is acknowledged as `00 F4`. Register the acknowledgement wait before issuing the write and allow only one data packet in flight. Other control commands are confirmed by completion of their GATT Write Request; do not assume they generate application notifications.

## Packet sizes and flow control

| Mode | Image bytes per packet | Header bytes | Maximum total packet length |
| --- | ---: | ---: | ---: |
| Safe | 16 | 4 | 20 bytes |
| Fast | 240 | 4 | 244 bytes |

Safe mode is the default. Fast mode must be probed with the first 240-byte black/white plane data packet after buffer clearing and offset reset. Continue fast mode only after a successful write and the matching `00 F4` notification. On a fast-packet write failure, acknowledgement timeout, or abnormal disconnect, fall back to safe mode and restart the current plane from its beginning. Never send concurrent packets or retry while an earlier write is still pending.

Initial configured timeouts are 3 seconds for write and notification, with up to two packet retries. The browser does not expose a general request-MTU-247 or connection-priority API; do not claim either operation was performed.

## Browser and privacy constraints

Serve the page over HTTPS. On Android Chrome, opening the device chooser must be triggered by a user gesture such as tapping Connect. Check secure-context and Web Bluetooth availability before presenting connection as possible. A GATT connection by itself does not establish readiness; discovery, notification subscription, and the application handshake must all succeed.

The verified image path requires the explicit `writeValueWithResponse()` API. A browser that only exposes the deprecated `writeValue()` API may be used for discovery and the acknowledged handshake, but image and screen writes must remain disabled because JavaScript cannot guarantee WRITE_REQUEST semantics. Chrome 78 is known to have this limitation.

Image processing is local to the browser. Diagnostic reports may include app/browser compatibility information, event metadata, and a redacted device identifier. Do not include the complete image planes or a full image hex dump in a report.
