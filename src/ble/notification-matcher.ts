export interface NotificationSource {
  addEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
  removeEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
}

/** Installs the listener synchronously, before the corresponding GATT write. */
export function expectNotification(
  source: NotificationSource,
  expected: Uint8Array,
  timeoutMs: number,
  signal?: AbortSignal,
): { promise: Promise<void>; dispose(): void } {
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  // The write may fail before the caller awaits this promise; keep its rejection handled.
  void promise.catch(() => undefined);
  const cleanup = () => {
    source.removeEventListener("characteristicvaluechanged", listener);
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  };
  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    error === undefined ? resolve() : reject(error);
  };
  const onAbort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  const listener: EventListener = (event) => {
    const value = (event.target as { value?: DataView } | null)?.value;
    if (!value || value.byteLength !== expected.length) return;
    for (let i = 0; i < expected.length; i += 1) if (value.getUint8(i) !== expected[i]) return;
    finish();
  };
  source.addEventListener("characteristicvaluechanged", listener);
  signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => finish(new Error(`Notification timeout after ${timeoutMs} ms`)), timeoutMs);
  if (signal?.aborted) onAbort();
  return { promise, dispose: () => finish(new DOMException("Notification matcher disposed", "AbortError")) };
}
