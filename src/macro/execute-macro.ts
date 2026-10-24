import type { MacroOperation, ParsedMacro } from "./parse-nrf-xml";

export type MacroWriter = (operation: Extract<MacroOperation, { kind: "write" }>, signal?: AbortSignal) => Promise<void>;
export type MacroSleeper = (durationMs: number, signal?: AbortSignal) => Promise<void>;

export interface MacroExecutionResult {
  completedOperations: number;
  requestedMtu: number | null;
  suggestedMode: "safe" | "fast";
  connectionPriorities: Array<Extract<MacroOperation, { kind: "request-connection-priority" }> ["priority"]>;
}

/** Executes operations in document order. MTU/priority requests are reported, never issued by the browser. */
export async function executeMacro(
  macro: ParsedMacro,
  dependencies: { writer: MacroWriter; sleeper: MacroSleeper },
  signal?: AbortSignal,
): Promise<MacroExecutionResult> {
  const connectionPriorities: MacroExecutionResult["connectionPriorities"] = [];
  let completedOperations = 0;
  for (const operation of macro.operations) {
    throwIfAborted(signal);
    switch (operation.kind) {
      case "write": await dependencies.writer(operation, signal); break;
      case "sleep": await dependencies.sleeper(operation.durationMs, signal); break;
      case "request-mtu": break;
      case "request-connection-priority": connectionPriorities.push(operation.priority); break;
    }
    throwIfAborted(signal);
    completedOperations++;
  }
  return { completedOperations, requestedMtu: macro.requestedMtu, suggestedMode: macro.suggestedMode, connectionPriorities };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    throw new DOMException("The operation was aborted", "AbortError");
  }
}
