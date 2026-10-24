import type { ActiveTransferMode, BleTransport, ConnectionInfo, PlaneName, ProcessedImage, TransferOptions, TransferProgress, TransportCallbacks } from "../contracts";
import { XM3YN_E31A as profile } from "../devices/xm3yn-e31a";
import { PacketQueue, writeRequest, type EpdWriter } from "./packet-queue";

interface GattCharacteristic extends EpdWriter {
  properties: { write: boolean; writeWithoutResponse?: boolean; notify: boolean };
  startNotifications(): Promise<GattCharacteristic>;
}
interface GattService { getCharacteristic(uuid: string): Promise<GattCharacteristic> }
interface GattServer {
  connected: boolean;
  getPrimaryService(uuid: string): Promise<GattService>;
}
interface DeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: { connected: boolean; connect(): Promise<GattServer>; disconnect(): void };
}
export interface BluetoothProvider { requestDevice(options: unknown): Promise<DeviceLike> }

export class WebBluetoothAdapter implements BleTransport {
  private readonly bluetooth: BluetoothProvider | undefined;
  private device: DeviceLike | null = null;
  private server: GattServer | null = null;
  private uart: GattCharacteristic | null = null;
  private epd: GattCharacteristic | null = null;
  private queue: PacketQueue | null = null;
  private callbacks: TransportCallbacks = {};
  private connectedHandler = () => this.onDisconnected();

  constructor(bluetooth?: BluetoothProvider) {
    this.bluetooth = bluetooth ?? (typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { bluetooth?: BluetoothProvider }).bluetooth);
  }

  setCallbacks(callbacks: TransportCallbacks): void { this.callbacks = callbacks; }
  isConnected(): boolean { return !!this.server?.connected && !!this.epd && !!this.uart; }

  async connect(signal?: AbortSignal): Promise<ConnectionInfo> {
    this.checkAbort(signal);
    const bluetooth = this.bluetooth;
    if (!bluetooth) {
      throw new Error("当前浏览器环境不支持 Web Bluetooth；请使用 HTTPS 页面并在 Android Chrome 中打开。");
    }
    if (this.device) this.disconnect();
    let selected: DeviceLike | null = null;
    try {
      this.callbacks.onPhase?.("SELECTING");
      selected = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [profile.uartServiceUuid, profile.epdServiceUuid] });
      this.device = selected;
      selected.addEventListener("gattserverdisconnected", this.connectedHandler);
      if (!selected.gatt) throw new Error("Selected device does not expose a GATT server");
      this.callbacks.onPhase?.("CONNECTING");
      this.server = await selected.gatt.connect();
      this.checkAbort(signal);
      this.callbacks.onPhase?.("DISCOVERING");
      const uartService = await this.server.getPrimaryService(String(profile.uartServiceUuid));
      this.uart = await uartService.getCharacteristic(String(profile.uartCharacteristicUuid));
      if (!this.uart.properties.write) throw new Error("UART characteristic does not support Write Request");
      const epdService = await this.server.getPrimaryService(String(profile.epdServiceUuid));
      this.epd = await epdService.getCharacteristic(String(profile.epdCharacteristicUuid));
      if (!this.epd.properties.write) throw new Error("EPD characteristic does not support Write Request");
      if (!this.epd.properties.notify) throw new Error("EPD characteristic does not support notifications");
      await this.epd.startNotifications();
      this.checkAbort(signal);
      this.queue = new PacketQueue(this.epd, { writeTimeoutMs: 3000, notificationTimeoutMs: 3000, maxPacketRetries: 2 });
      const writeMethod = typeof this.uart.writeValueWithResponse === "function"
        && typeof this.epd.writeValueWithResponse === "function"
        ? "with-response" : "legacy";
      return { deviceName: selected.name ?? "XM3YN", deviceId: selected.id, profileId: profile.id, notificationsEnabled: true, writeMethod };
    } catch (error) {
      selected?.removeEventListener("gattserverdisconnected", this.connectedHandler);
      if (selected?.gatt?.connected) selected.gatt.disconnect();
      this.reset();
      throw error;
    }
  }

  disconnect(): void {
    const device = this.device;
    this.reset();
    device?.gatt?.disconnect();
  }

  async handshake(signal?: AbortSignal): Promise<void> {
    this.checkAbort(signal);
    if (!this.uart || !this.queue) throw new Error("Device is not connected");
    this.callbacks.onPhase?.("HANDSHAKING");
    await writeRequest(this.uart, profile.commands.enterImageMode.slice().buffer);
    this.checkAbort(signal);
    await this.queue.send(profile.commands.handshake, signal);
    this.callbacks.onPhase?.("READY");
  }

  async clear(color: "white" | "black", signal?: AbortSignal): Promise<void> {
    this.requireExplicitWriteRequest();
    if (!this.uart) throw new Error("Device is not connected");
    const queue = this.requireQueue();
    // Match the verified nRF Macro: every screen operation starts by disabling
    // the firmware's clock scene, not only the initial connection handshake.
    await writeRequest(this.uart, profile.commands.enterImageMode.slice().buffer);
    this.checkAbort(signal);
    await queue.send(color === "white" ? profile.commands.whiteBuffer : profile.commands.blackBuffer, signal);
    await queue.send(profile.commands.refresh, signal);
  }

  async upload(image: Pick<ProcessedImage, "blackWhite" | "yellow">, options: TransferOptions, signal?: AbortSignal): Promise<ActiveTransferMode> {
    if (!this.epd || !this.uart) throw new Error("Device is not connected");
    this.requireExplicitWriteRequest();
    let retries = 0;
    const queue = this.queue = new PacketQueue(this.epd, {
      writeTimeoutMs: options.writeTimeoutMs,
      notificationTimeoutMs: options.notificationTimeoutMs,
      maxPacketRetries: options.maxPacketRetries,
      onRetry: () => { retries += 1; },
    });
    if (image.blackWhite.length !== profile.planeByteLength || image.yellow.length !== profile.planeByteLength) throw new Error("Image plane length does not match XM3YN profile");
    let mode: ActiveTransferMode = options.mode === "safe" ? "safe" : "fast";
    const totalBytes = profile.planeByteLength * 2;
    let confirmedBytes = 0;
    let confirmedPackets = 0;
    let totalPackets = packetCount(profile.planeByteLength, mode) * 2;
    // E1 00 is the first operation in the known-good nRF Macro. Repeating it
    // here prevents a reconnect or intervening scene change from rendering
    // into the same RAM buffers while image packets are arriving.
    await writeRequest(this.uart, profile.commands.enterImageMode.slice().buffer);
    this.checkAbort(signal);
    await queue.send(profile.commands.clearBuffers, signal);
    await queue.send(profile.commands.resetOffset, signal);
    const planes = ["blackWhite", "yellow"] as const;
    for (let planeIndex = 0; planeIndex < planes.length; planeIndex += 1) {
      const plane = planes[planeIndex]!;
      const baseBytes = confirmedBytes;
      const basePackets = confirmedPackets;
      try {
        ({ confirmedBytes, confirmedPackets } = await this.uploadPlane(
          plane, image[plane], mode, signal,
          { confirmedBytes, confirmedPackets, totalBytes, totalPackets, retries: () => retries },
        ));
      } catch (error) {
        if (isAbortError(error) || mode !== "fast" || !isPacketFailure(error)) throw error;
        mode = "safe";
        confirmedBytes = baseBytes;
        confirmedPackets = basePackets;
        totalPackets = basePackets + packetCount(profile.planeByteLength, "safe") * (planes.length - planeIndex);
        this.callbacks.onDiagnostic?.({ timestamp: new Date().toISOString(), level: "warning", category: "transfer", code: "FAST_FALLBACK", message: "Fast transfer failed; retrying current plane in safe mode" });
        await queue.send(profile.commands.resetOffset, signal);
        ({ confirmedBytes, confirmedPackets } = await this.uploadPlane(
          plane, image[plane], "safe", signal,
          { confirmedBytes, confirmedPackets, totalBytes, totalPackets, retries: () => retries },
        ));
      }
    }
    this.callbacks.onProgress?.({
      phase: "REFRESHING", plane: null, activeMode: mode,
      confirmedBytes, totalBytes, confirmedPackets, totalPackets, retries,
    });
    await queue.send(profile.commands.refresh, signal);
    return mode;
  }

  private async uploadPlane(
    plane: PlaneName,
    data: Uint8Array,
    mode: ActiveTransferMode,
    signal: AbortSignal | undefined,
    progressState: {
      confirmedBytes: number;
      confirmedPackets: number;
      totalBytes: number;
      totalPackets: number;
      retries: () => number;
    },
  ): Promise<{ confirmedBytes: number; confirmedPackets: number }> {
    const queue = this.requireQueue();
    const payloadSize = mode === "fast" ? profile.fastPayloadBytes : profile.safePayloadBytes;
    let { confirmedBytes, confirmedPackets } = progressState;
    for (let offset = 0; offset < data.length; offset += payloadSize) {
      this.checkAbort(signal);
      const payload = data.subarray(offset, Math.min(offset + payloadSize, data.length));
      const command = Uint8Array.of(0x03, profile.planeSelectors[plane], offset >> 8, offset & 0xff, ...payload);
      await queue.send(command, signal);
      confirmedBytes += payload.length;
      confirmedPackets += 1;
      const progress: TransferProgress = {
        phase: plane === "blackWhite" ? "UPLOADING_BW" : "UPLOADING_YELLOW", plane, activeMode: mode,
        confirmedBytes, totalBytes: progressState.totalBytes,
        confirmedPackets, totalPackets: progressState.totalPackets, retries: progressState.retries(),
      };
      this.callbacks.onProgress?.(progress);
    }
    return { confirmedBytes, confirmedPackets };
  }

  private requireQueue(): PacketQueue { if (!this.queue) throw new Error("Device is not connected"); return this.queue; }
  private requireExplicitWriteRequest(): void {
    if (typeof this.uart?.writeValueWithResponse !== "function" || typeof this.epd?.writeValueWithResponse !== "function") {
      throw new Error("当前 Chrome 只提供旧版 writeValue，无法保证价签所需的 WRITE_REQUEST；请更新 Chrome 后重新连接。");
    }
  }
  private checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
  private onDisconnected(): void { this.reset(); this.callbacks.onDisconnected?.("GATT server disconnected"); }
  private reset(): void {
    this.device?.removeEventListener("gattserverdisconnected", this.connectedHandler);
    this.device = null; this.server = null; this.uart = null; this.epd = null; this.queue = null;
  }
}

function isPacketFailure(error: unknown): boolean {
  return error instanceof Error && (/timeout/i.test(error.message) || /write/i.test(error.message) || /disconnected/i.test(error.message));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function packetCount(byteLength: number, mode: ActiveTransferMode): number {
  const payloadSize = mode === "fast" ? profile.fastPayloadBytes : profile.safePayloadBytes;
  return Math.ceil(byteLength / payloadSize);
}
