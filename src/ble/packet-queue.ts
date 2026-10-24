import { expectNotification, type NotificationSource } from "./notification-matcher";

export interface EpdWriter extends NotificationSource {
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  /** Legacy Web Bluetooth name used by Chrome 78; PROPERTY_WRITE keeps request semantics. */
  writeValue?(value: BufferSource): Promise<void>;
}
export interface QueueOptions {
  writeTimeoutMs: number;
  notificationTimeoutMs: number;
  maxPacketRetries: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
async function writeWithTimeout(writer: EpdWriter, packet: Uint8Array, timeoutMs: number): Promise<void> {
  const buffer = new ArrayBuffer(packet.byteLength);
  new Uint8Array(buffer).set(packet);
  const write = writeRequest(writer, buffer);
  let timer: ReturnType<typeof setTimeout>;
  let timedOut = false;
  try {
    await Promise.race([
      write,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error(`GATT write timeout after ${timeoutMs} ms`)); }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) await write.catch(() => undefined);
    throw error;
  } finally { clearTimeout(timer!); }
}

export function writeRequest(writer: EpdWriter, value: BufferSource): Promise<void> {
  if (typeof writer.writeValueWithResponse === "function") return writer.writeValueWithResponse(value);
  if (typeof writer.writeValue === "function") return writer.writeValue(value);
  return Promise.reject(new Error("Browser does not expose a GATT Write Request API"));
}

/** Strictly serializes acknowledged EPD writes, including retries. */
export class PacketQueue {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly writer: EpdWriter, private readonly options: QueueOptions) {}

  send(command: Uint8Array, signal?: AbortSignal): Promise<void> {
    const operation = this.tail.then(() => this.sendNow(command, signal));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async sendNow(command: Uint8Array, signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      aborted(signal);
      const expected = command[0] === 0x03 ? Uint8Array.of(command.length >> 8, command.length & 0xff) : null;
      const matcher = expected ? expectNotification(this.writer, expected, this.options.notificationTimeoutMs, signal) : null;
      try {
        // A write timeout is terminal: the browser write cannot be cancelled safely,
        // so retrying could overlap an unresolved GATT operation.
        const packet = command.slice();
        await writeWithTimeout(this.writer, packet, this.options.writeTimeoutMs);
        if (matcher) await matcher.promise;
        return;
      } catch (error) {
        matcher?.dispose();
        aborted(signal);
        if (attempt >= this.options.maxPacketRetries || String(error).includes("GATT write timeout")) throw error;
        this.options.onRetry?.(attempt + 1, error);
      }
    }
  }
}
