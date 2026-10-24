import { describe, expect, it } from "vitest";
import { PacketQueue, type EpdWriter } from "../../src/ble/packet-queue";
import { XM3YN_E31A } from "../../src/devices/xm3yn-e31a";

class FakeEpd extends EventTarget {
  writes: Uint8Array[] = [];
  active = 0;
  maxActive = 0;
  behavior: (data: Uint8Array) => Promise<void> = async (data) => this.ack(data.length);
  async writeValueWithResponse(data: BufferSource): Promise<void> {
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data instanceof DataView ? data.buffer : data.buffer);
    this.writes.push(bytes.slice());
    try { await this.behavior(bytes); } finally { this.active -= 1; }
  }
  ack(length: number): void {
    const view = new DataView(new ArrayBuffer(2)); view.setUint16(0, length);
    Object.defineProperty(this, "value", { configurable: true, value: view });
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}
const opts = { writeTimeoutMs: 100, notificationTimeoutMs: 20, maxPacketRetries: 1 };

describe("XM3YN packet protocol", () => {
  it("encodes data packets with selector, big endian offset and exact packet length", async () => {
    const epd = new FakeEpd(); const q = new PacketQueue(epd, opts);
    const payload = Uint8Array.from({ length: 16 }, (_, i) => i);
    const packet = Uint8Array.of(3, XM3YN_E31A.planeSelectors.blackWhite, 0x12, 0x34, ...payload);
    await q.send(packet);
    expect([...epd.writes[0]!]).toEqual([3, 255, 0x12, 0x34, ...payload]);
    expect(epd.writes[0]).toHaveLength(20);
  });

  it("allows only one unconfirmed packet and catches an acknowledgement sent before write resolves", async () => {
    const epd = new FakeEpd();
    epd.behavior = async (data) => { epd.ack(data.length); await new Promise((resolve) => setTimeout(resolve, 2)); };
    const q = new PacketQueue(epd, opts);
    await Promise.all([q.send(Uint8Array.of(3, 255, 0, 0, 1)), q.send(Uint8Array.of(3, 255, 0, 1, 2))]);
    expect(epd.maxActive).toBe(1);
    expect(epd.writes).toHaveLength(2);
  });

  it("retries a notification timeout serially", async () => {
    const epd = new FakeEpd(); let calls = 0;
    epd.behavior = async (data) => { if (++calls > 1) epd.ack(data.length); };
    await new PacketQueue(epd, opts).send(Uint8Array.of(3, 0, 0, 0));
    expect(epd.writes).toHaveLength(2);
  });

  it("stops retries when cancelled", async () => {
    const epd = new FakeEpd(); const controller = new AbortController();
    epd.behavior = async () => { controller.abort(); };
    await expect(new PacketQueue(epd, opts).send(Uint8Array.of(3, 0, 0, 0), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(epd.writes).toHaveLength(1);
  });

  it("uses the legacy Chrome writeValue API when writeValueWithResponse is absent", async () => {
    const source = new FakeEpd();
    const legacy: EpdWriter = {
      addEventListener: source.addEventListener.bind(source),
      removeEventListener: source.removeEventListener.bind(source),
      writeValue: source.writeValueWithResponse.bind(source),
    };

    await new PacketQueue(legacy, opts).send(Uint8Array.of(3, 0xff, 0, 0));

    expect(source.writes).toHaveLength(1);
  });
});
