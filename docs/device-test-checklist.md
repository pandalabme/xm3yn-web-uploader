# XM3YN@ E31A device test checklist

Use this checklist with the XM3YN@ E31A 296 × 152 yellow panel. Record the date, Android device, Chrome version, app build, transfer mode, result, and exported diagnostic report for each run. Keep the same test images when comparing runs. Do not use another model to infer this device's behavior.

## Before each run

- [ ] Confirm the target is XM3YN@ E31A and the panel is powered with a stable supply.
- [ ] Open the deployed page over HTTPS in Android Chrome.
- [ ] Confirm the page reports a secure context and Web Bluetooth availability.
- [ ] Tap Connect to open the chooser; do not attempt to open it from page load or a background task.
- [ ] Select the target device and confirm both expected services and characteristics are discovered by full UUID.
- [ ] Confirm EPD notifications are enabled and the application handshake reports `00 04` for `03 FF 00 00` before declaring the device ready.
- [ ] Export a diagnostic report if any discovery, notification, or handshake step fails. The report must show the browser compatibility fields and a redacted device ID.

## Repeatable functional sequence

Run in order. For each step, note whether the screen changed as expected and whether the UI/log reported confirmed completion.

1. [ ] **Handshake without image change.** Connect and complete the no-payload probe. Confirm the existing screen remains unchanged. If the probe changes the screen or position unexpectedly, stop and report the observation; do not substitute an unverified command.
2. [ ] **Write API check.** Confirm the page reports “explicit WRITE_REQUEST”. If it reports legacy `writeValue`, stop: image and screen writes must be disabled until Chrome is updated.
3. [ ] **Orientation test image.** Upload a fixed image with four distinct corner marks in safe mode. Confirm left/right and top/bottom orientation against the preview.
4. [ ] **Three-color test image.** Upload fixed black, white, and yellow regions in safe mode. Confirm all three colors and region placement.
5. [ ] **Reference image.** Upload the same `weather.png` used by the project reference in safe mode. Compare the displayed result and both encoded 5,624-byte planes against the known successful nRF Macro result.
6. [ ] **Repeatability.** Repeat the same full safe-mode upload twice more. Confirm each run completes all packet acknowledgements and refresh, with no overlapping writes or false success state.
7. [ ] **Fast-mode capability probe.** Only after the safe-mode checks pass, run auto/fast mode. Confirm the 240-byte probe succeeds and receives `00 F4` before any further fast packets are sent. Compare the result with the safe-mode image.
8. [ ] **Fast-mode failure fallback.** In a controlled test, make the fast probe fail or time out. Confirm the uploader switches to 16-byte payloads and restarts the current plane from its beginning. Do not simulate failure by sending guessed commands.
9. [ ] **Same-plane transport isolation.** When a web upload renders incorrectly, export the current image Macro and play `xm3yn-current-safe-nrf.xml` in Android nRF Connect without changing image options. Record whether the two paths produce the same screen result.

## Reliability checks

- [ ] Cancel during a transfer. Confirm the current write is allowed to settle, no subsequent packets are queued, and no refresh command is sent after cancellation.
- [ ] Observe a notification timeout or failed write in a controlled test. Confirm the report includes the phase, packet metadata, retry/fallback result, and final state without containing full image hex.
- [ ] During a test upload, lock the phone or move it out of range in a controlled run. Record whether the browser pauses, disconnects, or resumes; confirm the UI does not claim success and that the event is exportable.
- [ ] Reconnect after a disconnect. Confirm services/characteristics are discovered again, notifications are re-enabled, and the handshake completes before another transfer.
- [ ] Export both JSON and plain-text reports. Check they include application/browser compatibility data, events, and only a redacted device ID.

## Run record

| Field | Value |
| --- | --- |
| Date and time | |
| Android device / OS | |
| Chrome version | |
| App build | |
| Transfer mode | |
| Test image identifiers | |
| Steps passed / skipped | |
| Observed failures and event codes | |
| Diagnostic report filename | |
