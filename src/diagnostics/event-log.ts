import type { DiagnosticEvent } from "../contracts";

/** In-memory append-only log. Returned events and snapshots are detached and frozen. */
export class EventLog {
  private entries: readonly DiagnosticEvent[] = Object.freeze([]);

  constructor(private readonly capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Event log capacity must be a positive integer.");
    }
  }

  append(event: DiagnosticEvent): DiagnosticEvent {
    const stored = freezeEvent(event);
    this.entries = Object.freeze([...this.entries, stored].slice(-this.capacity));
    return stored;
  }

  snapshot(): readonly DiagnosticEvent[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }
}

function freezeEvent(event: DiagnosticEvent): DiagnosticEvent {
  const copy: DiagnosticEvent = {
    timestamp: event.timestamp,
    level: event.level,
    category: event.category,
    code: event.code,
    message: event.message,
    ...(event.details === undefined ? {} : { details: deepCopyAndFreeze(event.details) as Readonly<Record<string, unknown>> }),
  };
  return Object.freeze(copy);
}

function deepCopyAndFreeze(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  // Date setters still mutate a frozen Date, so retain only its immutable value.
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Object.freeze(Array.from(value as unknown as ArrayLike<number>));
  if (value instanceof ArrayBuffer) return Object.freeze(Array.from(new Uint8Array(value)));
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(deepCopyAndFreeze(item, seen));
    return Object.freeze(result);
  }
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) result[key] = deepCopyAndFreeze(item, seen);
  return Object.freeze(result);
}
