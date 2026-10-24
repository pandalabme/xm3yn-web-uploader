import { describe, expect, it } from "vitest";
import type { DiagnosticEvent } from "../../src/contracts";
import { EventLog } from "../../src/diagnostics/event-log";
import {
  createDiagnosticReport, exportReportJson, exportReportText,
} from "../../src/diagnostics/export-report";

function event(code: string, details?: Readonly<Record<string, unknown>>): DiagnosticEvent {
  return { timestamp: `2026-10-22T00:00:0${code.length}Z`, level: "info", category: "ble", code, message: `${code} occurred`, details };
}

describe("EventLog", () => {
  it("keeps append order and retains only the newest events within capacity", () => {
    const log = new EventLog(2);
    log.append(event("FIRST"));
    log.append(event("SECOND"));
    log.append(event("THIRD"));
    expect(log.size).toBe(2);
    expect(log.snapshot().map((item) => item.code)).toEqual(["SECOND", "THIRD"]);
  });

  it("detaches and freezes appended events and snapshots", () => {
    const sourceDetails = { nested: { value: "before" }, list: [1, 2] };
    const source = event("SAFE", sourceDetails);
    const log = new EventLog();
    const stored = log.append(source);
    sourceDetails.nested.value = "after";
    expect((stored.details?.nested as { value: string }).value).toBe("before");
    expect(Object.isFrozen(log.snapshot())).toBe(true);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.details)).toBe(true);
    expect(Object.isFrozen(stored.details?.nested)).toBe(true);
    expect(() => { (stored.details!.nested as { value: string }).value = "mutated"; }).toThrow();
    expect(() => (log.snapshot() as DiagnosticEvent[]).push(event("INJECTED"))).toThrow();
    expect(log.snapshot().map((item) => item.code)).toEqual(["SAFE"]);
  });
});

describe("diagnostic report exports", () => {
  const input = {
    app: { name: "XM3YN Web Uploader", version: "0.1.0" },
    browser: { userAgent: "Android Chrome test", secureContext: true, webBluetoothAvailable: true, platform: "Android" },
    device: { name: "XM3YN@ E31A", profileId: "xm3yn-e31a", id: "device-123456789" },
    events: [event("HANDSHAKE_OK", {
      secureContext: true,
      payloadHex: "03ff0000" + "ab".repeat(32),
      imageBytes: new Uint8Array([1, 2, 3]),
      confirmedBytes: 16,
      packetLength: 4,
    })],
    generatedAt: "2026-10-22T12:00:00.000Z",
  } as const;

  it("exports browser compatibility, events, and a redacted device id without binary image data", () => {
    const report = createDiagnosticReport(input);
    const json = exportReportJson(report);
    expect(report.device?.id).toBe("dev…789");
    expect(json).toContain("Android Chrome test");
    expect(json).toContain("secureContext");
    expect(json).toContain("HANDSHAKE_OK");
    expect(json).toContain("packetLength");
    expect(json).toContain('"confirmedBytes": 16');
    expect(json).not.toContain("device-123456789");
    expect(json).not.toContain("03ff0000");
    expect(json).not.toContain("010203");
    expect(json).toContain("[omitted]");
  });

  it("creates readable plain text with the same key report information", () => {
    const text = exportReportText(createDiagnosticReport(input));
    expect(text).toContain("Application: XM3YN Web Uploader 0.1.0");
    expect(text).toContain("Browser: Android Chrome test");
    expect(text).toContain("Secure context: yes");
    expect(text).toContain("id dev…789");
    expect(text).toContain("HANDSHAKE_OK");
    expect(text).not.toContain("device-123456789");
    expect(text).not.toContain("03ff0000");
  });
});
