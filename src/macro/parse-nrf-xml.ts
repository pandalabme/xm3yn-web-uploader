import type { DeviceProfile } from "../contracts";
import { XM3YN_E31A } from "../devices/xm3yn-e31a";

export type MacroOperation =
  | { kind: "write"; serviceUuid: string; characteristicUuid: string; value: Uint8Array; description?: string; position: SourcePosition }
  | { kind: "sleep"; durationMs: number; position: SourcePosition }
  | { kind: "request-mtu"; value: number; position: SourcePosition }
  | { kind: "request-connection-priority"; priority: "HIGH" | "BALANCED" | "LOW_POWER"; position: SourcePosition };

export interface SourcePosition { line: number; column: number; offset: number }
export interface ParseMacroOptions { profile?: DeviceProfile; mode: "safe" | "fast" }
export interface ParsedMacro {
  name: string;
  operations: MacroOperation[];
  requestedMtu: number | null;
  suggestedMode: "safe" | "fast";
}

interface XmlTag { name: string; attributes: Record<string, string>; selfClosing: boolean; position: SourcePosition }

export class MacroParseError extends Error {
  readonly position: SourcePosition;
  constructor(message: string, position: SourcePosition) {
    super(`${message} (line ${position.line}, column ${position.column})`);
    this.name = "MacroParseError";
    this.position = position;
  }
}

/** Strict, dependency-free reader for the small nRF Connect Macro XML subset we support. */
export function parseNrfMacro(xml: string, options: ParseMacroOptions): ParsedMacro {
  const profile = options.profile ?? XM3YN_E31A;
  const scanner = new XmlScanner(xml);
  let root: XmlTag | null = null;
  let macroName = "";
  let closed = false;
  const operations: MacroOperation[] = [];
  let requestedMtu: number | null = null;

  while (!scanner.done) {
    scanner.skipWhitespace();
    if (scanner.done) break;
    if (scanner.peek() !== "<") {
      const pos = scanner.position();
      const text = scanner.readText();
      if (text.trim().length) throw new MacroParseError("Unexpected text outside an operation", pos);
      continue;
    }
    if (scanner.startsWith("<!--")) { scanner.skipComment(); continue; }
    if (scanner.startsWith("<?")) { scanner.skipProcessingInstruction(); continue; }
    if (scanner.startsWith("<!")) throw new MacroParseError("DOCTYPE and declarations are not supported", scanner.position());

    const tag = scanner.readTag();
    if (!root) {
      if (tag.name !== "macro" || tag.selfClosing) throw new MacroParseError("Expected a <macro> root element", tag.position);
      assertAttributes(tag, ["name", "icon"]);
      if (!tag.attributes.name?.trim()) throw new MacroParseError("Macro name is required", tag.position);
      root = tag;
      macroName = tag.attributes.name;
      continue;
    }
    if (tag.name === "/macro") {
      if (Object.keys(tag.attributes).length || tag.selfClosing) throw new MacroParseError("Malformed macro closing tag", tag.position);
      closed = true;
      scanner.skipWhitespace();
      if (!scanner.done) throw new MacroParseError("Unexpected content after </macro>", scanner.position());
      break;
    }
    if (!tag.selfClosing) throw new MacroParseError(`Operation <${tag.name}> must be self-closing`, tag.position);
    operations.push(parseOperation(tag, profile, options.mode));
    const last = operations[operations.length - 1];
    if (last?.kind === "request-mtu") requestedMtu = last.value;
  }

  if (!root) throw new MacroParseError("Missing <macro> root element", scanner.position());
  if (!closed) throw new MacroParseError("Missing </macro> closing tag", root.position);
  return { name: macroName, operations, requestedMtu, suggestedMode: requestedMtu !== null && requestedMtu >= 247 ? "fast" : "safe" };
}

function parseOperation(tag: XmlTag, profile: DeviceProfile, mode: "safe" | "fast"): MacroOperation {
  switch (tag.name) {
    case "write": {
      assertAttributes(tag, ["description", "type", "service-uuid", "characteristic-uuid", "value"]);
      const { type, "service-uuid": rawService, "characteristic-uuid": rawCharacteristic, value: rawValue } = tag.attributes;
      if (type !== "WRITE_REQUEST") throw new MacroParseError("Only WRITE_REQUEST writes are supported", tag.position);
      if (!rawService || !rawCharacteristic || rawValue === undefined) throw new MacroParseError("Write requires service-uuid, characteristic-uuid, and value", tag.position);
      const serviceUuid = normalizeUuid(rawService);
      const characteristicUuid = normalizeUuid(rawCharacteristic);
      const uartPair = serviceUuid === normalizeUuid(String(profile.uartServiceUuid)) && characteristicUuid === normalizeUuid(String(profile.uartCharacteristicUuid));
      const epdPair = serviceUuid === normalizeUuid(String(profile.epdServiceUuid)) && characteristicUuid === normalizeUuid(String(profile.epdCharacteristicUuid));
      if (!uartPair && !epdPair) throw new MacroParseError("Write UUIDs do not match a service and characteristic in the selected device profile", tag.position);
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(rawValue)) throw new MacroParseError("Write value must be non-empty, even-length hexadecimal", tag.position);
      const value = hexToBytes(rawValue);
      if (value[0] === 0x03) {
        if (!epdPair) throw new MacroParseError("Image data packets must target the EPD characteristic", tag.position);
        if (value.length < 4) throw new MacroParseError("Image data packet is shorter than its four-byte header", tag.position);
        const payloadBytes = value.length - 4;
        const limit = mode === "safe" ? profile.safePayloadBytes : profile.fastPayloadBytes;
        if (payloadBytes > limit) throw new MacroParseError(`Image packet payload ${payloadBytes} exceeds ${mode} limit ${limit}`, tag.position);
        if (value[1] !== profile.planeSelectors.blackWhite && value[1] !== profile.planeSelectors.yellow) throw new MacroParseError("Image packet has an unknown plane selector", tag.position);
        const offset = (value[2]! << 8) | value[3]!;
        if (offset + payloadBytes > profile.planeByteLength) throw new MacroParseError("Image packet extends beyond the configured plane length", tag.position);
      }
      return { kind: "write", serviceUuid, characteristicUuid, value, ...(tag.attributes.description !== undefined ? { description: tag.attributes.description } : {}), position: tag.position };
    }
    case "sleep": {
      assertAttributes(tag, ["duration", "value"]);
      if ((tag.attributes.duration === undefined) === (tag.attributes.value === undefined)) throw new MacroParseError("Sleep requires exactly one of duration or value (milliseconds)", tag.position);
      const durationMs = positiveInteger(tag.attributes.duration ?? tag.attributes.value, "Sleep duration", tag.position, true);
      return { kind: "sleep", durationMs, position: tag.position };
    }
    case "request-mtu": {
      assertAttributes(tag, ["description", "value"]);
      const value = positiveInteger(tag.attributes.value, "MTU", tag.position);
      if (value < 23 || value > 517) throw new MacroParseError("MTU must be between 23 and 517", tag.position);
      return { kind: "request-mtu", value, position: tag.position };
    }
    case "request-connection-priority": {
      assertAttributes(tag, ["description", "type"]);
      const priority = tag.attributes.type;
      if (priority !== "HIGH" && priority !== "BALANCED" && priority !== "LOW_POWER") throw new MacroParseError("Connection priority must be HIGH, BALANCED, or LOW_POWER", tag.position);
      return { kind: "request-connection-priority", priority, position: tag.position };
    }
    default: throw new MacroParseError(`Unknown operation <${tag.name}>`, tag.position);
  }
}

function assertAttributes(tag: XmlTag, allowed: string[]): void {
  for (const name of Object.keys(tag.attributes)) if (!allowed.includes(name)) throw new MacroParseError(`Unknown attribute "${name}" on <${tag.name}>`, tag.position);
}
function normalizeUuid(value: string): string { return value.toLowerCase(); }
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function positiveInteger(raw: string | undefined, label: string, position: SourcePosition, allowZero = false): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new MacroParseError(`${label} must be an integer`, position);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) throw new MacroParseError(`${label} is out of range`, position);
  return value;
}

class XmlScanner {
  private index = 0;
  constructor(private readonly source: string) {}
  get done(): boolean { return this.index >= this.source.length; }
  peek(): string { return this.source[this.index] ?? ""; }
  startsWith(value: string): boolean { return this.source.startsWith(value, this.index); }
  position(): SourcePosition {
    const before = this.source.slice(0, this.index);
    const line = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    return { line, column: this.index - lastNewline, offset: this.index };
  }
  skipWhitespace(): void { while (/\s/.test(this.peek()) && !this.done) this.index++; }
  readText(): string { const start = this.index; while (!this.done && this.peek() !== "<") this.index++; return this.source.slice(start, this.index); }
  skipComment(): void {
    const start = this.position(); const end = this.source.indexOf("-->", this.index + 4);
    if (end < 0) throw new MacroParseError("Unterminated XML comment", start);
    this.index = end + 3;
  }
  skipProcessingInstruction(): void {
    const start = this.position(); const end = this.source.indexOf("?>", this.index + 2);
    if (end < 0) throw new MacroParseError("Unterminated processing instruction", start);
    this.index = end + 2;
  }
  readTag(): XmlTag {
    const position = this.position();
    this.index++;
    let closing = false;
    if (this.peek() === "/") { closing = true; this.index++; }
    const name = this.readName();
    const attributes: Record<string, string> = {};
    let selfClosing = false;
    while (true) {
      this.skipWhitespace();
      if (this.done) throw new MacroParseError("Unterminated XML tag", position);
      if (this.startsWith("/>")) { selfClosing = true; this.index += 2; break; }
      if (this.peek() === ">") { this.index++; break; }
      if (closing) throw new MacroParseError("Closing tags cannot have attributes", position);
      const key = this.readName();
      if (Object.hasOwn(attributes, key)) throw new MacroParseError(`Duplicate attribute "${key}"`, position);
      this.skipWhitespace();
      if (this.peek() !== "=") throw new MacroParseError(`Expected = after attribute "${key}"`, position);
      this.index++; this.skipWhitespace();
      const quote = this.peek();
      if (quote !== "\"" && quote !== "'") throw new MacroParseError(`Attribute "${key}" must be quoted`, position);
      this.index++;
      const valueStart = this.index;
      while (!this.done && this.peek() !== quote) this.index++;
      if (this.done) throw new MacroParseError(`Unterminated attribute "${key}"`, position);
      attributes[key] = decodeEntities(this.source.slice(valueStart, this.index), position);
      this.index++;
    }
    return { name: closing ? `/${name}` : name, attributes, selfClosing, position };
  }
  private readName(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(this.source.slice(this.index));
    if (!match) throw new MacroParseError("Expected an XML element or attribute name", this.position());
    this.index += match[0].length;
    return match[0];
  }
}

function decodeEntities(value: string, position: SourcePosition): string {
  if (/&(?![A-Za-z]+;|#\d+;|#x[\da-f]+;)/i.test(value)) throw new MacroParseError("Malformed XML entity", position);
  return value.replace(/&([^;]+);/g, (_entity, name: string) => {
    const values: Record<string, string> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" };
    if (values[name] !== undefined) return values[name]!;
    if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
    if (/^#x[\da-f]+$/i.test(name)) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    throw new MacroParseError(`Unsupported XML entity &${name};`, position);
  });
}
