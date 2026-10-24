import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeMacro } from "../../src/macro/execute-macro";
import { MacroParseError, parseNrfMacro } from "../../src/macro/parse-nrf-xml";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const safeXml = readFileSync(resolve(fixtures, "weather_xm3yn_safe_v2.xml"), "utf8");
const fastXml = readFileSync(resolve(fixtures, "weather_xm3yn_fast_v2.xml"), "utf8");

describe("nRF Connect Macro compatibility", () => {
  it("parses the existing safe macro against the 16-byte payload limit", () => {
    const macro = parseNrfMacro(safeXml, { mode: "safe" });
    const writes = macro.operations.filter((operation) => operation.kind === "write");
    expect(macro.name).toBe("XM3YN weather safe v2");
    expect(macro.suggestedMode).toBe("safe");
    expect(macro.requestedMtu).toBeNull();
    expect(writes.length).toBeGreaterThan(500);
    expect(writes.filter((operation) => operation.kind === "write" && operation.value[0] === 3).every((operation) => operation.kind === "write" && operation.value.length <= 20)).toBe(true);
  });

  it("parses the existing fast macro, retaining browser-unsupported requests as metadata", () => {
    const macro = parseNrfMacro(fastXml, { mode: "fast" });
    expect(macro.name).toBe("XM3YN weather fast v2");
    expect(macro.requestedMtu).toBe(247);
    expect(macro.suggestedMode).toBe("fast");
    expect(macro.operations.slice(1, 3).map((operation) => operation.kind)).toEqual(["request-mtu", "request-connection-priority"]);
    expect(() => parseNrfMacro(fastXml, { mode: "safe" })).toThrow(/exceeds safe limit 16/);
  });

  it("rejects UUIDs outside the selected device profile with source position", () => {
    const bad = safeXml.replace("00001f10-0000-1000-8000-00805f9b34fb", "0000180f-0000-1000-8000-00805f9b34fb");
    try { parseNrfMacro(bad, { mode: "safe" }); throw new Error("expected parse failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(MacroParseError);
      expect((error as MacroParseError).message).toContain("line 2, column");
    }
  });

  it("rejects invalid or odd-length hexadecimal", () => {
    const bad = safeXml.replace('value="E100"', 'value="E10G"');
    expect(() => parseNrfMacro(bad, { mode: "safe" })).toThrow(/even-length hexadecimal/);
    const odd = safeXml.replace('value="E100"', 'value="E1000"');
    expect(() => parseNrfMacro(odd, { mode: "safe" })).toThrow(/even-length hexadecimal/);
  });

  it("rejects unknown operations instead of skipping them", () => {
    const bad = safeXml.replace("</macro>", "  <reboot />\n</macro>");
    expect(() => parseNrfMacro(bad, { mode: "safe" })).toThrow(/Unknown operation <reboot> \(line/);
  });

  it("runs injected write and sleep operations serially and reports unsupported requests", async () => {
    const xml = `<macro name="serial"><write type="WRITE_REQUEST" service-uuid="00001f10-0000-1000-8000-00805f9b34fb" characteristic-uuid="00001f1f-0000-1000-8000-00805f9b34fb" value="E100"/><sleep duration="1"/><request-mtu value="247"/><request-connection-priority type="HIGH"/></macro>`;
    const macro = parseNrfMacro(xml, { mode: "fast" });
    const events: string[] = [];
    const result = await executeMacro(macro, {
      writer: async () => { events.push("write-start"); await Promise.resolve(); events.push("write-end"); },
      sleeper: async (duration) => { events.push(`sleep-${duration}`); },
    });
    expect(events).toEqual(["write-start", "write-end", "sleep-1"]);
    expect(result).toMatchObject({ completedOperations: 4, requestedMtu: 247, suggestedMode: "fast", connectionPriorities: ["HIGH"] });
  });

  it("stops on cancellation and does not execute later writes", async () => {
    const macro = parseNrfMacro(`<macro name="cancel"><sleep duration="5"/><write type="WRITE_REQUEST" service-uuid="00001f10-0000-1000-8000-00805f9b34fb" characteristic-uuid="00001f1f-0000-1000-8000-00805f9b34fb" value="E100"/></macro>`, { mode: "safe" });
    const controller = new AbortController();
    const writer = vi.fn(async () => {});
    const pending = executeMacro(macro, {
      writer,
      sleeper: async (_duration, signal) => {
        await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      },
    }, controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(writer).not.toHaveBeenCalled();
  });
});
