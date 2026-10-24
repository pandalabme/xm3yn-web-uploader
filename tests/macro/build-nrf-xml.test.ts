import { describe, expect, it } from "vitest";
import { XM3YN_E31A } from "../../src/devices/xm3yn-e31a";
import {
  NRF_FAST_MACRO_FILENAME, NRF_MACRO_FILENAME, NRF_MACRO_MIME_TYPE, buildFastNrfMacro, buildSafeNrfMacro,
} from "../../src/macro/build-nrf-xml";
import { parseNrfMacro } from "../../src/macro/parse-nrf-xml";

describe("safe nRF Macro export", () => {
  it("uses the MIME type requested by nRF Connect's Android file picker", () => {
    expect(NRF_MACRO_MIME_TYPE).toBe("text/xml;charset=utf-8");
    expect(NRF_MACRO_FILENAME).toBe("xm3yn-current-safe-nrf.xml");
    expect(NRF_FAST_MACRO_FILENAME).toBe("xm3yn-current-fast-nrf.xml");
  });

  it("emits lower-case UUID text for nRF Connect's case-sensitive preflight", () => {
    const plane = new Uint8Array(XM3YN_E31A.planeByteLength);
    const xml = buildSafeNrfMacro({ blackWhite: plane, yellow: plane });
    expect(xml).toContain(`service-uuid="${XM3YN_E31A.uartServiceUuid}"`);
    expect(xml).toContain(`characteristic-uuid="${XM3YN_E31A.epdCharacteristicUuid}"`);
    expect(xml).not.toContain("00001F10-0000-1000-8000-00805F9B34FB");
    expect(xml).not.toContain("4B646063-6264-F3A7-8941-E65356EA82FE");
  });

  it("round-trips two complete planes into the verified write sequence", () => {
    const blackWhite = Uint8Array.from({ length: XM3YN_E31A.planeByteLength }, (_, index) => index & 0xff);
    const yellow = Uint8Array.from({ length: XM3YN_E31A.planeByteLength }, (_, index) => 0xff - (index & 0xff));
    const parsed = parseNrfMacro(buildSafeNrfMacro({ blackWhite, yellow }, 'test & "image"'), { mode: "safe" });
    const writes = parsed.operations.filter((operation) => operation.kind === "write");

    expect(parsed.name).toBe('test & "image"');
    expect(writes).toHaveLength(708);
    expect(writes[0]?.value).toEqual(XM3YN_E31A.commands.enterImageMode);
    expect(writes[1]?.value).toEqual(XM3YN_E31A.commands.clearBuffers);
    expect(writes[2]?.value).toEqual(XM3YN_E31A.commands.resetOffset);
    expect(writes.at(-1)?.value).toEqual(XM3YN_E31A.commands.refresh);
    const dataWrites = writes.slice(3, -1);
    const decodedBlackWhite = Uint8Array.from(dataWrites.slice(0, 352).flatMap((operation) => [...operation.value.slice(4)]));
    const decodedYellow = Uint8Array.from(dataWrites.slice(352).flatMap((operation) => [...operation.value.slice(4)]));
    expect(decodedBlackWhite).toEqual(blackWhite);
    expect(decodedYellow).toEqual(yellow);
  });

  it("rejects incomplete image planes", () => {
    expect(() => buildSafeNrfMacro({ blackWhite: new Uint8Array(1), yellow: new Uint8Array(1) })).toThrow(/plane length/);
  });

  it("emits the verified MTU-247 fast sequence with complete 240-byte planes", () => {
    const blackWhite = Uint8Array.from({ length: XM3YN_E31A.planeByteLength }, (_, index) => index & 0xff);
    const yellow = Uint8Array.from({ length: XM3YN_E31A.planeByteLength }, (_, index) => 0xff - (index & 0xff));
    const parsed = parseNrfMacro(buildFastNrfMacro({ blackWhite, yellow }), { mode: "fast" });
    const writes = parsed.operations.filter((operation) => operation.kind === "write");

    expect(parsed.requestedMtu).toBe(247);
    expect(parsed.operations.slice(1, 3).map((operation) => operation.kind)).toEqual([
      "request-mtu", "request-connection-priority",
    ]);
    expect(writes).toHaveLength(52);
    expect(writes.at(-1)?.value).toEqual(XM3YN_E31A.commands.refresh);
    const dataWrites = writes.slice(3, -1);
    expect(dataWrites.every((operation) => operation.value.length <= 244)).toBe(true);
    const decodedBlackWhite = Uint8Array.from(dataWrites.slice(0, 24).flatMap((operation) => [...operation.value.slice(4)]));
    const decodedYellow = Uint8Array.from(dataWrites.slice(24).flatMap((operation) => [...operation.value.slice(4)]));
    expect(decodedBlackWhite).toEqual(blackWhite);
    expect(decodedYellow).toEqual(yellow);
  });
});
