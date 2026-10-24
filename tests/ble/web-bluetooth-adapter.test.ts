import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WebBluetoothAdapter, type BluetoothProvider } from "../../src/ble/web-bluetooth-adapter";
import { XM3YN_E31A } from "../../src/devices/xm3yn-e31a";
import { parseNrfMacro } from "../../src/macro/parse-nrf-xml";
import type { TransferOptions } from "../../src/contracts";

class FakeCharacteristic extends EventTarget {
  properties = { write: true, notify: true };
  value = new DataView(new ArrayBuffer(0));
  writes: Uint8Array[] = [];
  failLong = true;
  dropNotifications = 0;
  beforeWrite?: (bytes: Uint8Array) => void;
  constructor(private readonly label = "characteristic", private readonly operationLog: string[] = []) { super(); }
  async startNotifications(): Promise<this> { return this; }
  async writeValueWithResponse(source: BufferSource): Promise<void> {
    const bytes = new Uint8Array(source instanceof ArrayBuffer ? source : source instanceof DataView ? source.buffer : source.buffer).slice();
    this.writes.push(bytes);
    this.operationLog.push(`${this.label}:${hex(bytes)}`);
    this.beforeWrite?.(bytes);
    if (this.failLong && bytes.length > 20) throw new Error("GATT write rejected: packet exceeds negotiated length");
    if (bytes[0] === 3) {
      if (this.dropNotifications > 0) { this.dropNotifications -= 1; return; }
      this.value = new DataView(new ArrayBuffer(2)); this.value.setUint16(0, bytes.length);
      this.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  }
}

describe("WebBluetoothAdapter fast mode", () => {
  it("reports an actionable error when Web Bluetooth is unavailable", async () => {
    await expect(new WebBluetoothAdapter().connect()).rejects.toThrow(/HTTPS.*Android Chrome/);
  });

  it("falls back to 16-byte packets and restarts the current plane at offset zero", async () => {
    const epd = new FakeCharacteristic(); const uart = new FakeCharacteristic();
    const device = Object.assign(new EventTarget(), {
      id: "mock-device", name: "XM3YN mock",
      gatt: { connected: true, connect: async () => server, disconnect: () => undefined },
    });
    const service = (characteristic: FakeCharacteristic) => ({ getCharacteristic: async () => characteristic });
    const server = { connected: true, getPrimaryService: async (uuid: string) => service(uuid === XM3YN_E31A.uartServiceUuid ? uart : epd) };
    const provider: BluetoothProvider = { requestDevice: async () => device };
    const transport = new WebBluetoothAdapter(provider);
    const progress: Array<{ confirmedBytes: number; totalBytes: number; confirmedPackets: number; totalPackets: number }> = [];
    transport.setCallbacks({ onProgress: (event) => progress.push(event) });
    await transport.connect();
    const plane = new Uint8Array(XM3YN_E31A.planeByteLength);
    const result = await transport.upload({ blackWhite: plane, yellow: plane }, {
      mode: "auto", writeTimeoutMs: 50, notificationTimeoutMs: 50, maxPacketRetries: 0,
    } satisfies TransferOptions);
    expect(result).toBe("safe");
    expect(epd.writes[0]).toEqual(XM3YN_E31A.commands.clearBuffers);
    const dataWrites = epd.writes.filter((packet) => packet[0] === 3);
    expect(dataWrites[0]).toHaveLength(244);
    expect(dataWrites[1]).toHaveLength(20);
    expect(dataWrites[1]![2]).toBe(0);
    expect(dataWrites[1]![3]).toBe(0);
    expect(dataWrites[1]![1]).toBe(0xff);
    expect(progress.at(-1)).toMatchObject({ confirmedBytes: 11248, totalBytes: 11248, confirmedPackets: 704, totalPackets: 704 });
  });

  it("writes image mode before the acknowledged application handshake", async () => {
    const operations: string[] = [];
    const epd = new FakeCharacteristic("epd", operations);
    const uart = new FakeCharacteristic("uart", operations);
    const { provider } = mockProvider(uart, epd);
    const transport = new WebBluetoothAdapter(provider);
    const phases: string[] = [];
    transport.setCallbacks({ onPhase: (phase) => phases.push(phase) });
    await transport.connect();
    await transport.handshake();
    expect(operations).toEqual(["uart:e100", "epd:03ff0000"]);
    expect(phases).toEqual(["SELECTING", "CONNECTING", "DISCOVERING", "HANDSHAKING", "READY"]);
  });

  it("re-enters image mode at the start of every upload before touching EPD buffers", async () => {
    const operations: string[] = [];
    const epd = new FakeCharacteristic("epd", operations);
    const uart = new FakeCharacteristic("uart", operations);
    const { provider } = mockProvider(uart, epd);
    const transport = new WebBluetoothAdapter(provider);
    await transport.connect();
    const plane = new Uint8Array(XM3YN_E31A.planeByteLength);

    await transport.upload({ blackWhite: plane, yellow: plane }, {
      mode: "safe", writeTimeoutMs: 50, notificationTimeoutMs: 50, maxPacketRetries: 0,
    });

    expect(operations.slice(0, 3)).toEqual(["uart:e100", "epd:0000", "epd:020000"]);
    expect(operations.at(-1)).toBe("epd:0101");
  });

  it("emits the byte-identical write stream of the known-good safe nRF Macro", async () => {
    const operations: string[] = [];
    const epd = new FakeCharacteristic("epd", operations);
    const uart = new FakeCharacteristic("uart", operations);
    const { provider } = mockProvider(uart, epd);
    const transport = new WebBluetoothAdapter(provider);
    await transport.connect();
    const fixtures = resolve(import.meta.dirname, "../fixtures");
    const blackWhite = new Uint8Array(readFileSync(resolve(fixtures, "weather_black_white.bin")));
    const yellow = new Uint8Array(readFileSync(resolve(fixtures, "weather_yellow.bin")));
    const macroXml = readFileSync(resolve(fixtures, "weather_xm3yn_safe.xml"), "utf8");
    const macroWrites = parseNrfMacro(macroXml, { mode: "safe" }).operations
      .filter((operation) => operation.kind === "write")
      .map((operation) => `${operation.serviceUuid === XM3YN_E31A.uartServiceUuid ? "uart" : "epd"}:${hex(operation.value)}`);

    await transport.upload({ blackWhite, yellow }, {
      mode: "safe", writeTimeoutMs: 50, notificationTimeoutMs: 50, maxPacketRetries: 0,
    });

    expect(operations).toEqual(macroWrites);
  });

  it("identifies legacy Chrome and refuses image writes that cannot guarantee WRITE_REQUEST", async () => {
    const epd = new FakeCharacteristic();
    const uart = new FakeCharacteristic();
    const epdWrite = epd.writeValueWithResponse.bind(epd);
    const uartWrite = uart.writeValueWithResponse.bind(uart);
    Object.defineProperty(epd, "writeValueWithResponse", { value: undefined });
    Object.defineProperty(uart, "writeValueWithResponse", { value: undefined });
    Object.defineProperty(epd, "writeValue", { value: epdWrite });
    Object.defineProperty(uart, "writeValue", { value: uartWrite });
    const { provider } = mockProvider(uart, epd);
    const transport = new WebBluetoothAdapter(provider);

    const info = await transport.connect();
    expect(info.writeMethod).toBe("legacy");
    await transport.handshake();

    const plane = new Uint8Array(XM3YN_E31A.planeByteLength);
    await expect(transport.upload({ blackWhite: plane, yellow: plane }, {
      mode: "safe", writeTimeoutMs: 50, notificationTimeoutMs: 50, maxPacketRetries: 0,
    })).rejects.toThrow(/旧版 writeValue.*更新 Chrome/);
  });

  it("disconnects and removes its listener when service discovery fails", async () => {
    let disconnects = 0;
    let callbacks = 0;
    const device = Object.assign(new EventTarget(), {
      id: "broken-device", name: "Broken mock",
      gatt: {
        connected: true,
        connect: async () => ({ connected: true, getPrimaryService: async () => { throw new Error("missing service"); } }),
        disconnect: () => { disconnects += 1; device.gatt.connected = false; },
      },
    });
    const transport = new WebBluetoothAdapter({ requestDevice: async () => device });
    transport.setCallbacks({ onDisconnected: () => { callbacks += 1; } });
    await expect(transport.connect()).rejects.toThrow("missing service");
    expect(disconnects).toBe(1);
    expect(transport.isConnected()).toBe(false);
    device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(callbacks).toBe(0);
  });

  it("reports notification retries and does not downgrade an aborted fast upload", async () => {
    const epd = new FakeCharacteristic();
    const uart = new FakeCharacteristic();
    const { provider } = mockProvider(uart, epd);
    const transport = new WebBluetoothAdapter(provider);
    const progress: Array<{ retries: number }> = [];
    transport.setCallbacks({ onProgress: (event) => progress.push(event) });
    await transport.connect();
    epd.failLong = false;
    epd.dropNotifications = 1;
    const plane = new Uint8Array(XM3YN_E31A.planeByteLength);
    await transport.upload({ blackWhite: plane, yellow: plane }, {
      mode: "safe", writeTimeoutMs: 50, notificationTimeoutMs: 1, maxPacketRetries: 1,
    });
    expect(progress[0]?.retries).toBe(1);

    const controller = new AbortController();
    epd.beforeWrite = (bytes) => { if (bytes.length > 20) controller.abort(); };
    const writesBeforeAbort = epd.writes.length;
    await expect(transport.upload({ blackWhite: plane, yellow: plane }, {
      mode: "auto", writeTimeoutMs: 50, notificationTimeoutMs: 50, maxPacketRetries: 0,
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const attemptedData = epd.writes.slice(writesBeforeAbort).filter((bytes) => bytes[0] === 3);
    expect(attemptedData.map((bytes) => bytes.length)).toEqual([244]);
  });
});

function mockProvider(uart: FakeCharacteristic, epd: FakeCharacteristic): { provider: BluetoothProvider } {
  const service = (characteristic: FakeCharacteristic) => ({ getCharacteristic: async () => characteristic });
  const server = { connected: true, getPrimaryService: async (uuid: string) => service(uuid === XM3YN_E31A.uartServiceUuid ? uart : epd) };
  const device = Object.assign(new EventTarget(), {
    id: "mock-device", name: "XM3YN mock",
    gatt: { connected: true, connect: async () => server, disconnect: () => undefined },
  });
  return { provider: { requestDevice: async () => device } };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
