import type { DeviceProfile } from "../contracts";

/** Verified protocol constants for the XM3YN@ E31A yellow panel. */
export const XM3YN_E31A: DeviceProfile = {
  id: "xm3yn-e31a",
  label: "XM3YN@ E31A",
  width: 296,
  height: 152,
  planeByteLength: 5624,
  uartServiceUuid: "00001f10-0000-1000-8000-00805f9b34fb",
  uartCharacteristicUuid: "00001f1f-0000-1000-8000-00805f9b34fb",
  epdServiceUuid: "13187b10-eba9-a3ba-044e-83d3217d9a38",
  epdCharacteristicUuid: "4b646063-6264-f3a7-8941-e65356ea82fe",
  planeSelectors: { blackWhite: 0xff, yellow: 0x00 },
  safePayloadBytes: 16,
  fastPayloadBytes: 240,
  commands: {
    enterImageMode: Uint8Array.of(0xe1, 0x00),
    clearBuffers: Uint8Array.of(0x00, 0x00),
    whiteBuffer: Uint8Array.of(0x00, 0xff),
    blackBuffer: Uint8Array.of(0x00, 0x00),
    resetOffset: Uint8Array.of(0x02, 0x00, 0x00),
    refresh: Uint8Array.of(0x01, 0x01),
    handshake: Uint8Array.of(0x03, 0xff, 0x00, 0x00),
  },
};
