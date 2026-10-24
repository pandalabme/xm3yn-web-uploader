import type {
  AppPhase, AppSnapshot, BleTransport, ConnectionInfo, DiagnosticEvent,
  ImageProcessingOptions, ProcessedImage, TransferMode, TransferOptions,
  TransferProgress, TransportCallbacks,
} from "./contracts";
import { PLANE_BYTE_LENGTH } from "./contracts";
import { EventLog } from "./diagnostics/event-log";
import type { UiActions } from "./ui/view";

export type ImageProcessor = (file: File, options: ImageProcessingOptions) => Promise<ProcessedImage>;
export type SnapshotListener = (snapshot: AppSnapshot) => void;
interface Operation { id: number; controller: AbortController; promise: Promise<void>; complete: () => void; }

export interface AppControllerOptions {
  transport: BleTransport;
  processImage: ImageProcessor;
  onSnapshot?: SnapshotListener;
  onExport?: (snapshot: AppSnapshot) => void | Promise<void>;
  onExportMacro?: (snapshot: AppSnapshot) => void | Promise<void>;
  transferOptions?: Partial<TransferOptions>;
}

export const DEFAULT_TRANSFER_OPTIONS: Readonly<TransferOptions> = Object.freeze({
  mode: "safe", writeTimeoutMs: 3000, notificationTimeoutMs: 3000, maxPacketRetries: 2,
});

const TRANSITIONS: Readonly<Record<AppPhase, readonly AppPhase[]>> = {
  IDLE: ["SELECTING", "PREPROCESSING", "DISCONNECTED", "ERROR"],
  SELECTING: ["CONNECTING", "DISCOVERING", "HANDSHAKING", "READY", "DISCONNECTED", "ERROR"],
  CONNECTING: ["DISCOVERING", "HANDSHAKING", "READY", "DISCONNECTED", "ERROR"],
  DISCOVERING: ["HANDSHAKING", "READY", "DISCONNECTED", "ERROR"],
  HANDSHAKING: ["READY", "DISCONNECTED", "ERROR"],
  READY: ["PREPROCESSING", "UPLOADING_BW", "SELECTING", "REFRESHING", "DISCONNECTED", "ERROR"],
  PREPROCESSING: ["READY", "IDLE", "DISCONNECTED", "UPLOADING_BW", "CANCELLING", "ERROR"],
  UPLOADING_BW: ["UPLOADING_YELLOW", "REFRESHING", "CANCELLING", "DISCONNECTED", "ERROR"],
  UPLOADING_YELLOW: ["REFRESHING", "CANCELLING", "DISCONNECTED", "ERROR"],
  REFRESHING: ["DONE", "CANCELLING", "DISCONNECTED", "ERROR"],
  DONE: ["PREPROCESSING", "UPLOADING_BW", "REFRESHING", "SELECTING", "DISCONNECTED", "ERROR"],
  CANCELLING: ["READY", "IDLE", "DISCONNECTED", "ERROR"],
  DISCONNECTED: ["SELECTING", "PREPROCESSING", "ERROR"],
  ERROR: ["SELECTING", "PREPROCESSING", "DISCONNECTED"],
};

const TRANSFER_PHASES = new Set<AppPhase>(["PREPROCESSING", "UPLOADING_BW", "UPLOADING_YELLOW", "REFRESHING", "CANCELLING"]);

export class AppController {
  private snapshot: AppSnapshot = {
    phase: "IDLE", connection: null, processedImage: null, progress: null, diagnostics: [], errorMessage: null,
  };
  private operation: Operation | null = null;
  private operationId = 0;
  private readonly eventLog = new EventLog(500);
  private readonly callbacks: TransportCallbacks;
  private readonly transferOptions: TransferOptions;

  constructor(private readonly options: AppControllerOptions) {
    this.transferOptions = { ...DEFAULT_TRANSFER_OPTIONS, ...options.transferOptions };
    this.callbacks = {
      onPhase: (phase) => this.onTransportPhase(phase),
      onProgress: (progress) => this.onTransportProgress(progress),
      onDiagnostic: (event) => this.addDiagnostic(event),
      onDisconnected: (reason) => this.onTransportDisconnected(reason),
    };
    options.transport.setCallbacks(this.callbacks);
  }

  getSnapshot(): AppSnapshot { return this.snapshot; }

  getActions(): UiActions {
    return {
      onConnect: () => { void this.connect(); },
      onDisconnect: () => { void this.disconnect(); },
      onImage: (file, imageOptions) => { void this.selectImage(file, imageOptions); },
      onImageOptions: () => undefined,
      onStart: (mode) => { void this.start(mode); },
      onTestWhite: () => { void this.testWhite(); },
      onCancel: () => { void this.cancel(); },
      onExport: () => { void this.exportDiagnostics(); },
      onExportMacro: () => { void this.exportMacro(); },
    };
  }

  async connect(): Promise<void> {
    this.assertAvailable(["IDLE", "READY", "DONE", "DISCONNECTED", "ERROR"]);
    const prior = this.snapshot.phase;
    if (this.snapshot.connection) throw new Error("设备已连接。");
    if (prior === "READY" || prior === "DONE") throw new Error("当前状态不允许重复连接。");
    const op = this.beginOperation();
    this.snapshot = { ...this.snapshot, connection: null, errorMessage: null };
    this.transition("SELECTING");
    this.addDiagnostic(this.event("info", "ble", "CONNECT_REQUESTED", "等待选择并连接 XM3YN 设备。"));
    try {
      // Current transport combines selection, connection and service discovery.
      // Its phase callbacks may refine the visible phase; HANDSHAKING is guaranteed
      // once connect() resolves, even for transports without phase callbacks.
      if (this.snapshot.phase === "SELECTING") this.transition("CONNECTING");
      const connection = await this.options.transport.connect(op.controller.signal);
      this.assertCurrent(op.id);
      this.snapshot = { ...this.snapshot, connection };
      if (this.snapshot.phase === "CONNECTING" || this.snapshot.phase === "DISCOVERING" || this.snapshot.phase === "SELECTING") {
        this.transition("HANDSHAKING");
      }
      await this.options.transport.handshake(op.controller.signal);
      this.assertCurrent(op.id);
      this.transition("READY");
      this.addDiagnostic(this.event("info", "ble", "DEVICE_READY", "设备服务发现与通信握手已完成。"));
    } catch (error) {
      if (!this.isCurrent(op.id)) return;
      this.snapshot = { ...this.snapshot, connection: null };
      if (isAbortError(error)) {
        if (this.snapshot.phase !== "DISCONNECTED") this.transition("DISCONNECTED");
      } else this.fail(error, "CONNECT_FAILED", "ble");
    } finally { this.finishOperation(op.id); }
  }

  async selectImage(file: File, imageOptions: ImageProcessingOptions): Promise<void> {
    this.assertAvailable(["IDLE", "READY", "DONE", "DISCONNECTED", "ERROR"]);
    const returnPhase = this.snapshot.connection ? "READY" : (this.snapshot.phase === "DISCONNECTED" ? "DISCONNECTED" : "IDLE");
    const op = this.beginOperation();
    this.snapshot = { ...this.snapshot, errorMessage: null };
    this.transition("PREPROCESSING");
    this.addDiagnostic(this.event("info", "image", "IMAGE_PROCESSING", "正在本地处理所选图片。"));
    try {
      const processedImage = await this.options.processImage(file, imageOptions);
      this.assertCurrent(op.id);
      this.snapshot = { ...this.snapshot, processedImage };
      this.transition(returnPhase);
      this.addDiagnostic(this.event("info", "image", "IMAGE_READY", "图片已处理为 XM3YN 三色平面。"));
    } catch (error) {
      if (!this.isCurrent(op.id)) return;
      if (isAbortError(error)) {
        // A transport disconnect may abort preprocessing while already moving the
        // application to DISCONNECTED. Do not revive the prior READY/IDLE state.
        if (this.snapshot.phase !== "DISCONNECTED") this.transition(returnPhase);
      }
      else this.fail(error, "IMAGE_PROCESSING_FAILED", "image");
    } finally { this.finishOperation(op.id); }
  }

  async start(mode: TransferMode = this.transferOptions.mode): Promise<void> {
    this.assertAvailable(["READY", "DONE"]);
    if (!this.snapshot.connection || !this.options.transport.isConnected()) throw new Error("请先连接并完成设备握手。");
    if (!this.snapshot.processedImage) throw new Error("请先选择并处理图片。");
    const processedImage = this.snapshot.processedImage;
    const op = this.beginOperation();
    this.snapshot = { ...this.snapshot, errorMessage: null, progress: null };
    this.transition("UPLOADING_BW");
    this.addDiagnostic(this.event("info", "transfer", "UPLOAD_STARTED", `开始以${modeLabel(mode)}上传图片。`));
    try {
      const actualMode = await this.options.transport.upload(
        processedImage,
        { ...this.transferOptions, mode },
        op.controller.signal,
      );
      this.assertCurrent(op.id);
      if (this.snapshot.phase === "UPLOADING_BW" || this.snapshot.phase === "UPLOADING_YELLOW") this.transition("REFRESHING");
      if (this.snapshot.phase !== "REFRESHING") throw new Error(`传输结束时处于非法状态 ${this.snapshot.phase}。`);
      this.transition("DONE");
      this.addDiagnostic(this.event("info", "transfer", "UPLOAD_DONE", `所有数据包已确认，刷新命令已发出（${actualMode === "fast" ? "快速" : "安全"}模式）。`));
    } catch (error) {
      if (!this.isCurrent(op.id)) return;
      if (isAbortError(error)) { if (this.snapshot.phase !== "DISCONNECTED") this.settleCancellation(); }
      else this.fail(error, "UPLOAD_FAILED", "transfer");
    } finally { this.finishOperation(op.id); }
  }

  async testWhite(): Promise<void> {
    this.assertAvailable(["READY", "DONE"]);
    if (!this.snapshot.connection || !this.options.transport.isConnected()) throw new Error("请先连接并完成设备握手。");
    const op = this.beginOperation();
    this.snapshot = { ...this.snapshot, errorMessage: null, progress: null };
    this.transition("UPLOADING_BW");
    this.addDiagnostic(this.event("info", "transfer", "WHITE_TEST_STARTED", "开始通过完整双平面安全传输生成纯白测试画面。"));
    try {
      await this.options.transport.upload({
        blackWhite: new Uint8Array(PLANE_BYTE_LENGTH).fill(0xff),
        yellow: new Uint8Array(PLANE_BYTE_LENGTH),
      }, { ...this.transferOptions, mode: "safe" }, op.controller.signal);
      this.assertCurrent(op.id);
      if (this.snapshot.phase === "UPLOADING_BW" || this.snapshot.phase === "UPLOADING_YELLOW") this.transition("REFRESHING");
      if (this.snapshot.phase !== "REFRESHING") throw new Error(`纯白测试结束时处于非法状态 ${this.snapshot.phase}。`);
      this.transition("DONE");
      this.addDiagnostic(this.event("info", "transfer", "WHITE_TEST_DONE", "双平面纯白数据已确认，刷新命令已发出。"));
    } catch (error) {
      if (!this.isCurrent(op.id)) return;
      if (isAbortError(error)) { if (this.snapshot.phase !== "DISCONNECTED") this.settleCancellation(); }
      else this.fail(error, "WHITE_TEST_FAILED", "transfer");
    } finally { this.finishOperation(op.id); }
  }

  async clear(color: "white" | "black"): Promise<void> {
    this.assertAvailable(["READY", "DONE"]);
    if (!this.snapshot.connection || !this.options.transport.isConnected()) throw new Error("请先连接并完成设备握手。");
    const op = this.beginOperation();
    this.snapshot = { ...this.snapshot, errorMessage: null };
    this.transition("REFRESHING");
    this.addDiagnostic(this.event("info", "transfer", "CLEAR_STARTED", `开始清${color === "white" ? "白" : "黑"}屏。`));
    try {
      await this.options.transport.clear(color, op.controller.signal);
      this.assertCurrent(op.id);
      this.transition("DONE");
      this.addDiagnostic(this.event("info", "transfer", "CLEAR_DONE", "清屏写入与刷新命令已完成。"));
    } catch (error) {
      if (!this.isCurrent(op.id)) return;
      if (isAbortError(error)) { if (this.snapshot.phase !== "DISCONNECTED") this.settleCancellation(); }
      else this.fail(error, "CLEAR_FAILED", "transfer");
    } finally { this.finishOperation(op.id); }
  }

  async cancel(): Promise<void> {
    const op = this.operation;
    if (!op || !TRANSFER_PHASES.has(this.snapshot.phase) || this.snapshot.phase === "CANCELLING") return;
    this.transition("CANCELLING");
    this.addDiagnostic(this.event("warning", "app", "CANCEL_REQUESTED", "已请求取消；等待当前写入结束后停止后续命令。"));
    op.controller.abort(new DOMException("Operation cancelled", "AbortError"));
    await op.promise;
  }

  async disconnect(): Promise<void> {
    if (this.snapshot.phase === "IDLE" || this.snapshot.phase === "DISCONNECTED") return;
    const op = this.operation;
    if (op) {
      if (TRANSFER_PHASES.has(this.snapshot.phase) && this.snapshot.phase !== "CANCELLING") this.transition("CANCELLING");
      op.controller.abort(new DOMException("Disconnected by user", "AbortError"));
      this.options.transport.disconnect();
      if (TRANSFER_PHASES.has(this.snapshot.phase)) this.transition("DISCONNECTED");
      await op.promise;
    } else this.options.transport.disconnect();
    this.snapshot = { ...this.snapshot, connection: null };
    if (this.snapshot.phase !== "DISCONNECTED") this.transition("DISCONNECTED");
    this.addDiagnostic(this.event("info", "ble", "DISCONNECTED", "设备已断开。"));
  }

  async exportDiagnostics(): Promise<void> {
    if (!this.options.onExport) return;
    await this.options.onExport(this.snapshot);
  }

  async exportMacro(): Promise<void> {
    if (!this.snapshot.processedImage) throw new Error("请先选择并处理图片。");
    if (!this.options.onExportMacro) return;
    await this.options.onExportMacro(this.snapshot);
  }

  private onTransportPhase(phase: AppPhase): void {
    if (!this.operation || !this.isAllowed(phase)) return;
    if (phase === "UPLOADING_BW" || phase === "UPLOADING_YELLOW" || phase === "REFRESHING") {
      if (this.snapshot.phase === phase) return;
    }
    this.transition(phase);
  }
  private onTransportProgress(progress: TransferProgress): void {
    if (!this.operation || !TRANSFER_PHASES.has(this.snapshot.phase)) return;
    this.snapshot = { ...this.snapshot, progress };
    if (progress.phase !== this.snapshot.phase && this.isAllowed(progress.phase)) this.transition(progress.phase);
    else this.emit();
  }
  private onTransportDisconnected(reason: unknown): void {
    if (this.snapshot.phase === "DISCONNECTED") return;
    const op = this.operation;
    if (op) op.controller.abort(new DOMException("Device disconnected", "AbortError"));
    this.snapshot = { ...this.snapshot, connection: null };
    if (this.isAllowed("DISCONNECTED")) this.transition("DISCONNECTED");
    this.addDiagnostic(this.event("warning", "ble", "DEVICE_DISCONNECTED", `设备意外断开${reason ? `：${String(reason)}` : "。"}`));
  }

  private settleCancellation(): void {
    const phase: AppPhase = this.snapshot.connection && this.options.transport.isConnected() ? "READY" : "DISCONNECTED";
    this.transition(phase);
    this.addDiagnostic(this.event("info", "app", "CANCELLED", "任务已取消，未发送刷新命令。"));
  }
  private fail(error: unknown, code: string, category: DiagnosticEvent["category"]): void {
    const message = error instanceof Error ? error.message : String(error);
    this.snapshot = { ...this.snapshot, errorMessage: message };
    if (this.isAllowed("ERROR")) this.transition("ERROR");
    this.addDiagnostic(this.event("error", category, code, message));
  }
  private transition(next: AppPhase): void {
    if (!this.isAllowed(next)) throw new Error(`非法状态转移：${this.snapshot.phase} → ${next}`);
    this.snapshot = { ...this.snapshot, phase: next };
    this.emit();
  }
  private isAllowed(next: AppPhase): boolean { return this.snapshot.phase === next || TRANSITIONS[this.snapshot.phase].includes(next); }
  private assertAvailable(phases: readonly AppPhase[]): void {
    if (this.operation) throw new Error("已有操作正在进行。");
    if (!phases.includes(this.snapshot.phase)) throw new Error(`当前状态 ${this.snapshot.phase} 不允许此操作。`);
  }
  private beginOperation(): Operation {
    let complete!: () => void;
    const promise = new Promise<void>((resolve) => { complete = resolve; });
    const operation = { id: ++this.operationId, controller: new AbortController(), promise, complete };
    this.operation = operation;
    return operation;
  }
  private finishOperation(id: number): void {
    if (!this.isCurrent(id)) return;
    const operation = this.operation!;
    this.operation = null;
    operation.complete();
  }
  private isCurrent(id: number): boolean { return this.operation?.id === id; }
  private assertCurrent(id: number): void {
    if (!this.isCurrent(id) || this.operation!.controller.signal.aborted) throw new DOMException("Stale operation", "AbortError");
  }
  private emit(): void { this.options.onSnapshot?.(this.snapshot); }
  private addDiagnostic(event: DiagnosticEvent): void {
    this.eventLog.append(event);
    this.snapshot = { ...this.snapshot, diagnostics: this.eventLog.snapshot() };
    this.emit();
  }
  private event(level: DiagnosticEvent["level"], category: DiagnosticEvent["category"], code: string, message: string): DiagnosticEvent {
    return { timestamp: new Date().toISOString(), level, category, code, message };
  }
}

function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function modeLabel(mode: TransferMode): string { return mode === "safe" ? "安全模式" : mode === "auto" ? "自动模式" : "快速模式"; }

