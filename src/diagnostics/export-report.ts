import type { DiagnosticEvent } from "../contracts";

export interface DiagnosticReportInput {
  app: { name: string; version: string };
  browser: {
    userAgent: string;
    secureContext: boolean;
    webBluetoothAvailable: boolean;
    platform?: string;
  };
  device?: { name: string; profileId: string; id?: string } | null;
  events: readonly DiagnosticEvent[];
  generatedAt?: string;
}

export interface DiagnosticReport {
  formatVersion: 1;
  generatedAt: string;
  app: DiagnosticReportInput["app"];
  browser: DiagnosticReportInput["browser"];
  device: { name: string; profileId: string; id: string | null } | null;
  events: readonly DiagnosticEvent[];
}

/** Builds a detached, privacy-filtered report. It does not access browser globals or the DOM. */
export function createDiagnosticReport(input: DiagnosticReportInput): DiagnosticReport {
  return {
    formatVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    app: { ...input.app },
    browser: { ...input.browser },
    device: input.device ? {
      name: input.device.name,
      profileId: input.device.profileId,
      id: input.device.id ? redactDeviceId(input.device.id) : null,
    } : null,
    events: input.events.map(sanitizeEvent),
  };
}

export function redactDeviceId(id: string): string {
  const normalized = id.trim();
  if (normalized.length <= 6) return "••••••";
  return `${normalized.slice(0, 3)}…${normalized.slice(-3)}`;
}

export function exportReportJson(report: DiagnosticReport): string {
  return JSON.stringify(report, null, 2);
}

export function exportReportText(report: DiagnosticReport): string {
  const device = report.device
    ? `${report.device.name} (${report.device.profileId}; id ${report.device.id ?? "not available"})`
    : "Not connected";
  const lines = [
    `${report.app.name} diagnostic report`,
    `Generated: ${report.generatedAt}`,
    `Application: ${report.app.name} ${report.app.version}`,
    `Browser: ${report.browser.userAgent}`,
    `Platform: ${report.browser.platform ?? "not available"}`,
    `Secure context: ${report.browser.secureContext ? "yes" : "no"}`,
    `Web Bluetooth: ${report.browser.webBluetoothAvailable ? "available" : "unavailable"}`,
    `Device: ${device}`,
    `Events: ${report.events.length}`,
    "",
    "Event log:",
  ];
  for (const event of report.events) {
    const details = event.details ? ` ${JSON.stringify(event.details)}` : "";
    lines.push(`${event.timestamp} [${event.level}] ${event.category}/${event.code}: ${event.message}${details}`);
  }
  return lines.join("\n");
}

function sanitizeEvent(event: DiagnosticEvent): DiagnosticEvent {
  return {
    timestamp: event.timestamp,
    level: event.level,
    category: event.category,
    code: event.code,
    message: scrubLongHex(event.message),
    ...(event.details === undefined ? {} : { details: sanitizeValue(event.details) as Readonly<Record<string, unknown>> }),
  };
}

function sanitizeValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  // Omit fields that conventionally carry raw content, while retaining useful
  // numeric metadata such as confirmedBytes, packetLength and offset.
  if (/(?:hex|payload(?:data)?|buffer|pixels?|image.?data|raw.?data|imageBytes|rawBytes)$/i.test(key)) return "[omitted]";
  if (value === undefined) return undefined;
  if (typeof value === "string") return scrubLongHex(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (ArrayBuffer.isView(value)) {
    const size = value instanceof DataView ? value.byteLength : (value as unknown as { length: number }).length;
    return `[omitted typed data: ${size} items]`;
  }
  if (value instanceof ArrayBuffer) return `[omitted binary data: ${value.byteLength} bytes]`;
  if (seen.has(value)) return "[circular reference omitted]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, "", seen));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitizeValue(child, childKey, seen)]));
  }
  return String(value);
}

function scrubLongHex(value: string): string {
  return value.replace(/\b(?:0x)?(?:[\da-fA-F]{2}[\s:-]?){32,}\b/g, "[omitted long hex data]");
}
