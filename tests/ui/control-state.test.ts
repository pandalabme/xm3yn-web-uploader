import { describe, expect, it } from "vitest";
import type { AppPhase, AppSnapshot, ConnectionInfo, ProcessedImage } from "../../src/contracts";
import { DEFAULT_IMAGE_OPTIONS, IMAGE_FILE_ACCEPT, deriveUiControlState } from "../../src/ui/view";

const connection: ConnectionInfo = {
  deviceName: "XM3YN@ E31A",
  deviceId: "masked",
  profileId: "xm3yn-e31a",
  notificationsEnabled: true,
  writeMethod: "with-response",
};
const image = {} as ProcessedImage;

function snapshot(phase: AppPhase, connected = false, hasImage = false): AppSnapshot {
  return {
    phase,
    connection: connected ? connection : null,
    processedImage: hasImage ? image : null,
    progress: null,
    diagnostics: [],
    errorMessage: null,
  };
}

describe("deriveUiControlState", () => {
  it("uses the Android-compatible generic image MIME filter", () => {
    expect(IMAGE_FILE_ACCEPT).toBe("image/*");
  });

  it("keeps the verified red-to-yellow baseline enabled by default", () => {
    expect(DEFAULT_IMAGE_OPTIONS).toMatchObject({ fit: "cover", dither: "none", mapRedToYellow: true });
  });

  it("keeps connection and transfer actions unavailable while idle", () => {
    const state = deriveUiControlState(snapshot("IDLE"));
    expect(state.connectDisabled).toBe(false);
    expect(state.disconnectDisabled).toBe(true);
    expect(state.startDisabled).toBe(true);
    expect(state.clearDisabled).toBe(true);
    expect(state.imageInputDisabled).toBe(false);
    expect(state.steps.connect).toEqual({ active: false, complete: false });
  });

  it("marks discovery and handshake as separate active stages", () => {
    const discovering = deriveUiControlState(snapshot("DISCOVERING", true));
    expect(discovering.steps.connect).toEqual({ active: false, complete: true });
    expect(discovering.steps.discover).toEqual({ active: true, complete: false });

    const handshaking = deriveUiControlState(snapshot("HANDSHAKING", true));
    expect(handshaking.steps.discover).toEqual({ active: false, complete: true });
    expect(handshaking.steps.handshake).toEqual({ active: true, complete: false });
    expect(handshaking.connectDisabled).toBe(true);
  });

  it("enables ready actions only with a connected device and processed image", () => {
    const state = deriveUiControlState(snapshot("READY", true, true));
    expect(state.steps.handshake).toEqual({ active: false, complete: true });
    expect(state.connectDisabled).toBe(true);
    expect(state.startDisabled).toBe(false);
    expect(state.testWhiteDisabled).toBe(false);
    expect(state.exportMacroDisabled).toBe(false);
    expect(state.clearDisabled).toBe(false);
  });

  it("keeps screen writes disabled when the browser only exposes legacy writeValue", () => {
    const legacySnapshot = snapshot("READY", true, true);
    legacySnapshot.connection = { ...connection, writeMethod: "legacy" };
    const state = deriveUiControlState(legacySnapshot);
    expect(state.startDisabled).toBe(true);
    expect(state.testWhiteDisabled).toBe(true);
    expect(state.clearDisabled).toBe(true);
    expect(state.disconnectDisabled).toBe(false);
  });

  it("locks image and transfer controls during uploads", () => {
    const state = deriveUiControlState(snapshot("UPLOADING_BW", true, true));
    expect(state.startDisabled).toBe(true);
    expect(state.cancelDisabled).toBe(false);
    expect(state.clearDisabled).toBe(true);
    expect(state.imageInputDisabled).toBe(true);
    expect(state.optionsDisabled).toBe(true);
    expect(state.exportMacroDisabled).toBe(true);
    expect(state.steps.connect.active).toBe(false);
    expect(state.steps.connect.complete).toBe(true);
  });

  it("allows retransfer and clear after done while the connection remains", () => {
    const connected = deriveUiControlState(snapshot("DONE", true, true));
    expect(connected.connectDisabled).toBe(true);
    expect(connected.startDisabled).toBe(false);
    expect(connected.clearDisabled).toBe(false);

    const disconnected = deriveUiControlState(snapshot("DONE", false, true));
    expect(disconnected.startDisabled).toBe(true);
    expect(disconnected.clearDisabled).toBe(true);
  });

  it("keeps recovery operations unavailable after errors or disconnection", () => {
    for (const phase of ["ERROR", "DISCONNECTED"] as const) {
      const state = deriveUiControlState(snapshot(phase, false, true));
      expect(state.connectDisabled).toBe(false);
      expect(state.startDisabled).toBe(true);
      expect(state.clearDisabled).toBe(true);
      expect(state.cancelDisabled).toBe(true);
      expect(state.imageInputDisabled).toBe(false);
    }
  });
});
