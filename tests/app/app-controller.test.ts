import { describe, expect, it, vi } from "vitest";
import type {
  ActiveTransferMode, AppPhase, BleTransport, ConnectionInfo, ImageProcessingOptions,
  ProcessedImage, TransferOptions, TransportCallbacks,
} from "../../src/contracts";
import { AppController, DEFAULT_TRANSFER_OPTIONS } from "../../src/app-controller";

const imageOptions: ImageProcessingOptions = { fit: "cover", rotation: 0, dither: "none", mapRedToYellow: false };
const image: ProcessedImage = {
  width: 296, height: 152, previewRgba: new Uint8ClampedArray(296 * 152 * 4),
  blackWhite: new Uint8Array(5624), yellow: new Uint8Array(5624),
};
const connection: ConnectionInfo = {
  deviceName: "XM3YN", deviceId: "device-1", profileId: "xm3yn-e31a", notificationsEnabled: true, writeMethod: "with-response",
};

class FakeTransport implements BleTransport {
  callbacks: TransportCallbacks = {};
  connected = false;
  refreshes = 0;
  uploadOptions: TransferOptions | null = null;
  uploadedImage: Pick<ProcessedImage, "blackWhite" | "yellow"> | null = null;
  uploadImpl: (signal?: AbortSignal) => Promise<ActiveTransferMode> = async () => {
    this.callbacks.onPhase?.("UPLOADING_BW");
    this.callbacks.onPhase?.("UPLOADING_YELLOW");
    this.callbacks.onPhase?.("REFRESHING");
    this.refreshes += 1;
    return "safe";
  };

  setCallbacks(callbacks: TransportCallbacks): void { this.callbacks = callbacks; }
  async connect(): Promise<ConnectionInfo> { this.connected = true; return connection; }
  disconnect(): void { this.connected = false; }
  isConnected(): boolean { return this.connected; }
  async handshake(): Promise<void> {}
  async clear(): Promise<void> { this.refreshes += 1; }
  async upload(image: Pick<ProcessedImage, "blackWhite" | "yellow">, options: TransferOptions, signal?: AbortSignal): Promise<ActiveTransferMode> {
    this.uploadedImage = image;
    this.uploadOptions = options;
    return this.uploadImpl(signal);
  }
}

describe("AppController", () => {
  it("runs connection through handshake, processes locally, uploads and reaches DONE", async () => {
    const transport = new FakeTransport();
    const processor = vi.fn(async () => image);
    const snapshots: AppPhase[] = [];
    const app = new AppController({ transport, processImage: processor, onSnapshot: (snapshot) => snapshots.push(snapshot.phase) });

    await app.connect();
    expect(app.getSnapshot().phase).toBe("READY");
    expect(app.getSnapshot().connection).toEqual(connection);
    await app.selectImage(new File(["image"], "photo.png"), imageOptions);
    expect(processor).toHaveBeenCalledOnce();
    expect(app.getSnapshot().processedImage).toBe(image);
    await app.start("safe");

    expect(app.getSnapshot().phase).toBe("DONE");
    expect(transport.uploadOptions).toEqual(DEFAULT_TRANSFER_OPTIONS);
    expect(snapshots).toContain("HANDSHAKING");
    expect(snapshots).toContain("UPLOADING_YELLOW");
    expect(app.getSnapshot().diagnostics.map(({ code }) => code)).toContain("UPLOAD_DONE");
  });

  it("rejects actions from invalid phases and prevents a second concurrent operation", async () => {
    const transport = new FakeTransport();
    const app = new AppController({ transport, processImage: async () => image });
    await expect(app.clear("white")).rejects.toThrow("当前状态 IDLE");
    await app.connect();
    await app.selectImage(new File(["image"], "photo.png"), imageOptions);

    let release!: () => void;
    transport.uploadImpl = () => new Promise((resolve) => { release = () => resolve("safe"); });
    const first = app.start("safe");
    expect(app.getSnapshot().phase).toBe("UPLOADING_BW");
    await expect(app.start("fast")).rejects.toThrow("已有操作正在进行");
    release();
    await first;
    expect(app.getSnapshot().phase).toBe("DONE");
  });

  it("writes a pure-white diagnostic through both complete image planes", async () => {
    const transport = new FakeTransport();
    const app = new AppController({ transport, processImage: async () => image });
    await app.connect();

    await app.testWhite();

    expect(app.getSnapshot().phase).toBe("DONE");
    expect(transport.uploadOptions?.mode).toBe("safe");
    expect(transport.uploadedImage?.blackWhite).toHaveLength(5624);
    expect(transport.uploadedImage?.yellow).toHaveLength(5624);
    expect(transport.uploadedImage?.blackWhite.every((byte) => byte === 0xff)).toBe(true);
    expect(transport.uploadedImage?.yellow.every((byte) => byte === 0x00)).toBe(true);
    expect(app.getSnapshot().diagnostics.at(-1)?.code).toBe("WHITE_TEST_DONE");
  });

  it("cancels in-flight upload after the active write and never refreshes", async () => {
    const transport = new FakeTransport();
    const app = new AppController({ transport, processImage: async () => image });
    await app.connect();
    await app.selectImage(new File(["image"], "photo.png"), imageOptions);
    let rejectUpload!: (error: unknown) => void;
    transport.uploadImpl = (signal) => new Promise((_resolve, reject) => {
      rejectUpload = reject;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    const upload = app.start("safe");
    const cancellation = app.cancel();
    expect(app.getSnapshot().phase).toBe("CANCELLING");
    await cancellation;
    await upload;
    expect(app.getSnapshot().phase).toBe("READY");
    expect(transport.refreshes).toBe(0);
    expect(app.getSnapshot().diagnostics.map(({ code }) => code)).toContain("CANCELLED");
    void rejectUpload;
  });

  it("handles an unexpected disconnect, then performs a fresh connect and handshake", async () => {
    const transport = new FakeTransport();
    let handshakes = 0;
    transport.handshake = async () => { handshakes += 1; };
    const app = new AppController({ transport, processImage: async () => image });
    await app.connect();
    transport.connected = false;
    transport.callbacks.onDisconnected?.("radio lost");
    expect(app.getSnapshot().phase).toBe("DISCONNECTED");
    expect(app.getSnapshot().connection).toBeNull();
    await app.connect();
    expect(app.getSnapshot().phase).toBe("READY");
    expect(handshakes).toBe(2);
  });

  it("keeps an interrupted transfer disconnected and never marks it DONE", async () => {
    const transport = new FakeTransport();
    const app = new AppController({ transport, processImage: async () => image });
    await app.connect();
    await app.selectImage(new File(["image"], "photo.png"), imageOptions);
    transport.uploadImpl = (signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    const upload = app.start("safe");
    transport.connected = false;
    transport.callbacks.onDisconnected?.("radio lost");
    await upload;
    expect(app.getSnapshot().phase).toBe("DISCONNECTED");
    expect(app.getSnapshot().connection).toBeNull();
    expect(transport.refreshes).toBe(0);
  });

  it("does not restore READY after disconnecting during image preprocessing", async () => {
    const transport = new FakeTransport();
    let finishProcessing!: () => void;
    const app = new AppController({
      transport,
      processImage: () => new Promise((resolve) => { finishProcessing = () => resolve(image); }),
    });
    await app.connect();

    const processing = app.selectImage(new File(["image"], "photo.png"), imageOptions);
    expect(app.getSnapshot().phase).toBe("PREPROCESSING");
    const disconnecting = app.disconnect();
    finishProcessing();
    await Promise.all([processing, disconnecting]);

    expect(app.getSnapshot().phase).toBe("DISCONNECTED");
    expect(app.getSnapshot().connection).toBeNull();
  });

  it("forwards transport diagnostics and progress into the snapshot", async () => {
    const transport = new FakeTransport();
    const app = new AppController({ transport, processImage: async () => image });
    await app.connect();
    await app.selectImage(new File(["image"], "photo.png"), imageOptions);
    transport.uploadImpl = async () => {
      transport.callbacks.onProgress?.({
        phase: "UPLOADING_BW", plane: "blackWhite", activeMode: "safe", confirmedBytes: 16,
        totalBytes: 11248, confirmedPackets: 1, totalPackets: 704, retries: 0,
      });
      transport.callbacks.onDiagnostic?.({ timestamp: new Date().toISOString(), level: "warning", category: "transfer", code: "RETRY", message: "retry" });
      transport.callbacks.onPhase?.("REFRESHING");
      return "safe";
    };
    await app.start();
    expect(app.getSnapshot().progress?.confirmedBytes).toBe(16);
    expect(app.getSnapshot().diagnostics.at(-1)?.code).toBe("UPLOAD_DONE");
    expect(app.getSnapshot().diagnostics.some((event) => event.code === "RETRY")).toBe(true);
  });
});

