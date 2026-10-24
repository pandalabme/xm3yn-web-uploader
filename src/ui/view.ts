import {
  PANEL_HEIGHT,
  PANEL_WIDTH,
  type AppPhase,
  type AppSnapshot,
  type DiagnosticEvent,
  type ImageProcessingOptions,
  type TransferMode,
} from "../contracts";
import "./styles.css";

export interface UiActions {
  onConnect(): void;
  onDisconnect(): void;
  onImage(file: File, options: ImageProcessingOptions): void;
  onImageOptions(options: ImageProcessingOptions): void;
  onStart(mode: TransferMode): void;
  onTestWhite(): void;
  onCancel(): void;
  onExport(): void;
  onExportMacro(): void;
}

export const DEFAULT_IMAGE_OPTIONS: Readonly<ImageProcessingOptions> = Object.freeze({
  fit: "cover", rotation: 0, dither: "none", mapRedToYellow: true,
});

/** Generic image filtering is more reliable with Android DocumentsUI providers. */
export const IMAGE_FILE_ACCEPT = "image/*";

const PHASE_LABELS: Record<AppPhase, string> = {
  IDLE: "等待操作", SELECTING: "选择设备", CONNECTING: "正在连接",
  DISCOVERING: "正在检查设备服务", HANDSHAKING: "正在验证设备通信",
  READY: "设备就绪", PREPROCESSING: "正在处理图片", UPLOADING_BW: "正在传输黑白平面",
  UPLOADING_YELLOW: "正在传输黄色平面", REFRESHING: "正在刷新屏幕", DONE: "传输完成",
  CANCELLING: "正在取消", DISCONNECTED: "设备已断开", ERROR: "发生错误",
};

const busyPhases = new Set<AppPhase>(["SELECTING", "CONNECTING", "DISCOVERING", "HANDSHAKING", "PREPROCESSING", "UPLOADING_BW", "UPLOADING_YELLOW", "REFRESHING", "CANCELLING"]);
const transferPhases = new Set<AppPhase>(["PREPROCESSING", "UPLOADING_BW", "UPLOADING_YELLOW", "REFRESHING", "CANCELLING"]);

export interface UiControlState {
  connectDisabled: boolean;
  disconnectDisabled: boolean;
  startDisabled: boolean;
  testWhiteDisabled: boolean;
  exportMacroDisabled: boolean;
  cancelDisabled: boolean;
  clearDisabled: boolean;
  imageInputDisabled: boolean;
  optionsDisabled: boolean;
  steps: Record<"connect" | "discover" | "handshake", { active: boolean; complete: boolean }>;
}

export function deriveUiControlState(snapshot: AppSnapshot): UiControlState {
  const { phase, connection, processedImage } = snapshot;
  const connected = connection !== null;
  const verifiedWriteRequest = connection?.writeMethod === "with-response";
  const busy = busyPhases.has(phase);
  const inTransfer = transferPhases.has(phase);
  const progressed = new Set<AppPhase>(["HANDSHAKING", "READY", "PREPROCESSING", "UPLOADING_BW", "UPLOADING_YELLOW", "REFRESHING", "DONE"]);
  const terminalOrReady = new Set<AppPhase>(["READY", "DONE"]);
  return {
    connectDisabled: busy || connected,
    disconnectDisabled: !connected || inTransfer,
    startDisabled: !terminalOrReady.has(phase) || !connected || !verifiedWriteRequest || processedImage === null,
    testWhiteDisabled: !terminalOrReady.has(phase) || !connected || !verifiedWriteRequest,
    exportMacroDisabled: busy || processedImage === null,
    cancelDisabled: !["PREPROCESSING", "UPLOADING_BW", "UPLOADING_YELLOW", "REFRESHING"].includes(phase),
    clearDisabled: !terminalOrReady.has(phase) || !connected || !verifiedWriteRequest,
    imageInputDisabled: busy,
    optionsDisabled: busy,
    steps: {
      connect: { active: phase === "SELECTING" || phase === "CONNECTING", complete: connected },
      discover: { active: phase === "DISCOVERING", complete: progressed.has(phase) },
      handshake: { active: phase === "HANDSHAKING", complete: ["READY", "PREPROCESSING", "UPLOADING_BW", "UPLOADING_YELLOW", "REFRESHING", "DONE"].includes(phase) },
    },
  };
}

export class UploaderView {
  readonly element: HTMLElement;
  private readonly actions: UiActions;
  private readonly preview: HTMLCanvasElement;
  // The verified Python/Macro baseline maps clearly red artwork to the panel's
  // yellow plane, so keep that compatibility behavior enabled by default.
  private options: ImageProcessingOptions = { ...DEFAULT_IMAGE_OPTIONS };
  private selectedFile: File | null = null;
  private mode: TransferMode = "safe";
  private snapshot: AppSnapshot | null = null;

  constructor(root: HTMLElement, actions: UiActions) {
    this.element = root;
    this.actions = actions;
    root.innerHTML = `
      <main class="shell">
        <header class="page-head"><div><p class="eyebrow">XM3YN · E31A</p><h1>图片导入</h1></div><span class="local-tag">仅在本机处理</span></header>
        <section class="card" aria-labelledby="device-title">
          <div class="section-head"><div><p class="step">01 / 04</p><h2 id="device-title">设备</h2></div><span id="phase-badge" class="badge" aria-live="polite">等待操作</span></div>
          <p id="device-name" class="device-name">尚未连接设备</p>
          <ol class="device-steps" aria-label="连接与握手状态"><li data-step="connect">连接</li><li data-step="discover">服务发现</li><li data-step="handshake">通信握手</li></ol>
          <p id="device-detail" class="muted" aria-live="polite">连接后将检查服务、通知能力并验证通信。</p>
          <div class="button-row"><button id="connect" class="button primary">连接价签</button><button id="disconnect" class="button secondary">断开</button></div>
        </section>
        <section class="card" aria-labelledby="image-title">
          <div class="section-head"><div><p class="step">02 / 04</p><h2 id="image-title">图片</h2></div><span class="dimension">296 × 152</span></div>
          <label class="file-picker" for="image-file"><span class="file-icon" aria-hidden="true">＋</span><span><strong>选择图片</strong><small id="file-name">PNG、JPEG、WebP 或 BMP</small></span></label>
          <input id="image-file" type="file" accept="${IMAGE_FILE_ACCEPT}" />
          <div class="preview-wrap"><canvas id="preview" width="296" height="152" aria-label="量化后的 296 乘 152 图片预览"></canvas><p id="preview-empty">处理后的三色预览会显示在这里</p></div>
          <div class="options-grid">
            <label>适配方式<select id="fit"><option value="cover">裁剪填满</option><option value="contain">完整包含</option></select></label>
            <label>旋转<select id="rotation"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></label>
            <label>抖动<select id="dither"><option value="none">关闭</option><option value="floyd-steinberg">误差扩散</option></select></label>
            <label class="check-label"><input id="red-yellow" type="checkbox" checked /> 红色映射为黄色</label>
          </div>
          <p id="image-error" class="error-text" role="status"></p>
        </section>
        <section class="card" aria-labelledby="transfer-title">
          <div class="section-head"><div><p class="step">03 / 04</p><h2 id="transfer-title">传输</h2></div><span id="mode-badge" class="mode-badge">安全模式</span></div>
          <fieldset id="mode-options" class="mode-options"><legend class="sr-only">传输模式</legend><label><input type="radio" name="mode" value="safe" checked /> 安全</label><label><input type="radio" name="mode" value="auto" /> 自动探测</label></fieldset>
          <div class="progress-head"><span id="progress-label">等待传输</span><span id="progress-count">0 / 0 字节</span></div>
          <progress id="progress" max="1" value="0" aria-label="已确认传输进度"></progress>
          <p id="progress-detail" class="muted">进度按设备确认的数据计算。</p>
          <div class="button-row"><button id="start" class="button primary">开始传输</button><button id="cancel" class="button danger">取消</button></div>
          <div class="button-row"><button id="test-white" class="button secondary">双平面纯白诊断</button><button id="export-macro" class="button secondary">导出快速 Macro</button></div>
          <p class="muted">清屏测试已移除：实机证明单独发送 <code>00 FF</code> 不会可靠地产生白屏。</p>
          <p id="operation-error" class="error-text" role="alert"></p>
        </section>
        <section class="card" aria-labelledby="diagnostics-title">
          <div class="section-head"><div><p class="step">04 / 04</p><h2 id="diagnostics-title">诊断</h2></div><button id="export" class="button secondary small">导出记录</button></div>
          <p id="diagnostic-summary" class="muted">暂无事件</p><ol id="events" class="events" aria-live="polite" aria-relevant="additions text"></ol>
        </section>
        <footer>适用于 XM3YN@ E31A · 请保持手机屏幕常亮</footer>
      </main>`;
    this.preview = root.querySelector<HTMLCanvasElement>("#preview")!;
    this.bindEvents();
    this.renderControls();
  }

  render(snapshot: AppSnapshot): void {
    this.snapshot = snapshot;
    const phase = snapshot.phase;
    const connected = snapshot.connection !== null;
    const controls = deriveUiControlState(snapshot);
    this.text("phase-badge", PHASE_LABELS[phase]);
    this.text("device-name", connected ? snapshot.connection!.deviceName : "尚未连接设备");
    this.text("device-detail", connected
      ? `通知${snapshot.connection!.notificationsEnabled ? "已启用" : "未启用"} · 写入方式 ${snapshot.connection!.writeMethod === "with-response" ? "显式 WRITE_REQUEST" : "旧版 writeValue（不允许上传）"} · ${snapshot.connection!.profileId}`
      : phase === "HANDSHAKING" ? "服务已发现，正在等待设备确认握手。" : "连接后将检查服务、通知能力并验证通信。");
    this.setStep("connect", controls.steps.connect.complete, controls.steps.connect.active);
    this.setStep("discover", controls.steps.discover.complete, controls.steps.discover.active);
    this.setStep("handshake", controls.steps.handshake.complete, controls.steps.handshake.active);
    this.button("connect").disabled = controls.connectDisabled;
    this.button("disconnect").disabled = controls.disconnectDisabled;
    this.button("start").disabled = controls.startDisabled;
    this.button("test-white").disabled = controls.testWhiteDisabled;
    this.button("export-macro").disabled = controls.exportMacroDisabled;
    this.button("cancel").disabled = controls.cancelDisabled;
    this.button("export").disabled = snapshot.diagnostics.length === 0;
    this.element.querySelector<HTMLInputElement>("#image-file")!.disabled = controls.imageInputDisabled;
    this.element.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#mode-options input, #fit, #rotation, #dither, #red-yellow").forEach((input) => { input.disabled = controls.optionsDisabled; });
    this.button("start").textContent = phase === "DONE" ? "重新传输" : "开始传输";
    this.text("mode-badge", snapshot.progress ? `${snapshot.progress.activeMode === "fast" ? "快速" : "安全"}模式` : this.modeLabel());
    this.renderProgress(snapshot);
    this.renderPreview(snapshot);
    this.renderDiagnostics(snapshot.diagnostics);
    this.text("image-error", this.selectedFile && !snapshot.processedImage && snapshot.errorMessage ? snapshot.errorMessage : "");
    const compatibilityError = snapshot.connection?.writeMethod === "legacy"
      ? "当前 Chrome 无法显式执行 WRITE_REQUEST。请更新 Chrome，重新打开页面并连接后再上传。"
      : "";
    this.text("operation-error", snapshot.errorMessage ?? compatibilityError);
  }

  private bindEvents(): void {
    this.button("connect").addEventListener("click", () => this.actions.onConnect());
    this.button("disconnect").addEventListener("click", () => this.actions.onDisconnect());
    this.button("start").addEventListener("click", () => this.actions.onStart(this.mode));
    this.button("test-white").addEventListener("click", () => this.actions.onTestWhite());
    this.button("export-macro").addEventListener("click", () => this.actions.onExportMacro());
    this.button("cancel").addEventListener("click", () => this.actions.onCancel());
    this.button("export").addEventListener("click", () => this.actions.onExport());
    this.element.querySelector<HTMLInputElement>("#image-file")!.addEventListener("change", (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      if (!file) return;
      this.selectedFile = file;
      this.text("file-name", file.name);
      this.text("image-error", "");
      this.actions.onImage(file, this.options);
    });
    this.element.querySelectorAll<HTMLInputElement>("input[name=mode]").forEach((input) => input.addEventListener("change", () => {
      if (!input.checked) return;
      this.mode = input.value as TransferMode;
      this.text("mode-badge", this.modeLabel());
    }));
    for (const selector of ["#fit", "#rotation", "#dither", "#red-yellow"]) {
      this.element.querySelector(selector)!.addEventListener("change", () => this.updateOptions());
    }
  }

  private updateOptions(): void {
    this.options = {
      fit: this.element.querySelector<HTMLSelectElement>("#fit")!.value as ImageProcessingOptions["fit"],
      rotation: Number(this.element.querySelector<HTMLSelectElement>("#rotation")!.value) as ImageProcessingOptions["rotation"],
      dither: this.element.querySelector<HTMLSelectElement>("#dither")!.value as ImageProcessingOptions["dither"],
      mapRedToYellow: this.element.querySelector<HTMLInputElement>("#red-yellow")!.checked,
    };
    this.actions.onImageOptions(this.options);
    if (this.selectedFile) this.actions.onImage(this.selectedFile, this.options);
  }

  private renderControls(): void { this.text("mode-badge", this.modeLabel()); }
  private renderPreview(snapshot: AppSnapshot): void {
    const image = snapshot.processedImage;
    const ctx = this.preview.getContext("2d");
    if (!ctx) return;
    if (!image) { ctx.clearRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT); this.preview.hidden = true; this.element.querySelector("#preview-empty")!.removeAttribute("hidden"); return; }
    const frame = new ImageData(new Uint8ClampedArray(image.previewRgba), PANEL_WIDTH, PANEL_HEIGHT);
    ctx.putImageData(frame, 0, 0);
    this.preview.hidden = false;
    this.element.querySelector("#preview-empty")!.setAttribute("hidden", "");
  }

  private renderProgress(snapshot: AppSnapshot): void {
    const p = snapshot.progress;
    const progress = this.element.querySelector<HTMLProgressElement>("#progress")!;
    if (!p) { progress.max = 1; progress.value = 0; this.text("progress-label", "等待传输"); this.text("progress-count", "0 / 0 字节"); this.text("progress-detail", "进度按设备确认的数据计算。"); return; }
    progress.max = Math.max(1, p.totalBytes); progress.value = p.confirmedBytes;
    this.text("progress-label", PHASE_LABELS[p.phase]);
    this.text("progress-count", `${p.confirmedBytes.toLocaleString()} / ${p.totalBytes.toLocaleString()} 字节`);
    this.text("progress-detail", `${p.confirmedPackets} / ${p.totalPackets} 包已确认 · 重试 ${p.retries} 次 · 当前${p.activeMode === "fast" ? "快速" : "安全"}模式`);
  }

  private renderDiagnostics(events: readonly DiagnosticEvent[]): void {
    this.text("diagnostic-summary", events.length ? `共 ${events.length} 条事件，最新记录显示在顶部。` : "暂无事件");
    const list = this.element.querySelector<HTMLOListElement>("#events")!;
    const rows = [...events].slice(-100).reverse().map((event) => {
      const li = document.createElement("li"); li.className = `event event-${event.level}`;
      const time = document.createElement("time"); time.dateTime = event.timestamp; time.textContent = new Date(event.timestamp).toLocaleTimeString();
      const message = document.createElement("span"); message.textContent = event.message;
      const code = document.createElement("small"); code.textContent = `${event.category} · ${event.code}`;
      li.append(time, message, code); return li;
    });
    while (list.firstChild) list.removeChild(list.firstChild);
    list.append(...rows);
  }

  private setStep(name: string, complete: boolean, active = false): void {
    const step = this.element.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
    step.classList.toggle("complete", complete); step.classList.toggle("active", active);
    step.setAttribute("aria-current", active ? "step" : "false");
  }
  private button(id: string): HTMLButtonElement { return this.element.querySelector<HTMLButtonElement>(`#${id}`)!; }
  private text(id: string, value: string): void { this.element.querySelector<HTMLElement>(`#${id}`)!.textContent = value; }
  private modeLabel(): string { return ({ safe: "安全模式", auto: "自动探测", fast: "快速模式" })[this.mode]; }
}

export function createAppView(root: HTMLElement, actions: UiActions): UploaderView {
  return new UploaderView(root, actions);
}

