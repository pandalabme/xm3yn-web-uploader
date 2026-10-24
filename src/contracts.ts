export const PANEL_WIDTH = 296;
export const PANEL_HEIGHT = 152;
export const PLANE_BYTE_LENGTH = (PANEL_WIDTH * PANEL_HEIGHT) / 8;

export type AppPhase =
  | "IDLE"
  | "SELECTING"
  | "CONNECTING"
  | "DISCOVERING"
  | "HANDSHAKING"
  | "READY"
  | "PREPROCESSING"
  | "UPLOADING_BW"
  | "UPLOADING_YELLOW"
  | "REFRESHING"
  | "DONE"
  | "CANCELLING"
  | "DISCONNECTED"
  | "ERROR";

export type PlaneName = "blackWhite" | "yellow";
export type TransferMode = "safe" | "auto" | "fast";
export type ActiveTransferMode = "safe" | "fast";
export type FitMode = "cover" | "contain";
export type Rotation = 0 | 90 | 180 | 270;
export type DitherMode = "none" | "floyd-steinberg";

export interface ImageProcessingOptions {
  fit: FitMode;
  rotation: Rotation;
  dither: DitherMode;
  mapRedToYellow: boolean;
}

export interface ProcessedImage {
  width: typeof PANEL_WIDTH;
  height: typeof PANEL_HEIGHT;
  /** RGBA pixels after final three-colour quantization. */
  previewRgba: Uint8ClampedArray;
  blackWhite: Uint8Array;
  yellow: Uint8Array;
}

export interface DeviceProfile {
  id: string;
  label: string;
  width: number;
  height: number;
  planeByteLength: number;
  uartServiceUuid: BluetoothServiceUUID;
  uartCharacteristicUuid: BluetoothCharacteristicUUID;
  epdServiceUuid: BluetoothServiceUUID;
  epdCharacteristicUuid: BluetoothCharacteristicUUID;
  planeSelectors: Readonly<Record<PlaneName, number>>;
  safePayloadBytes: number;
  fastPayloadBytes: number;
  commands: {
    enterImageMode: Uint8Array;
    clearBuffers: Uint8Array;
    whiteBuffer: Uint8Array;
    blackBuffer: Uint8Array;
    resetOffset: Uint8Array;
    refresh: Uint8Array;
    handshake: Uint8Array;
  };
}

export interface ConnectionInfo {
  deviceName: string;
  deviceId: string;
  profileId: string;
  notificationsEnabled: boolean;
  /**
   * `legacy` means the browser only exposes the deprecated writeValue() API.
   * It cannot prove that the verified WRITE_REQUEST path will be used.
   */
  writeMethod: "with-response" | "legacy";
}

export interface TransferOptions {
  mode: TransferMode;
  writeTimeoutMs: number;
  notificationTimeoutMs: number;
  maxPacketRetries: number;
}

export interface TransferProgress {
  phase: Extract<AppPhase, "UPLOADING_BW" | "UPLOADING_YELLOW" | "REFRESHING">;
  plane: PlaneName | null;
  activeMode: ActiveTransferMode;
  confirmedBytes: number;
  totalBytes: number;
  confirmedPackets: number;
  totalPackets: number;
  retries: number;
}

export interface DiagnosticEvent {
  timestamp: string;
  level: "debug" | "info" | "warning" | "error";
  category: "app" | "ble" | "image" | "transfer" | "macro" | "browser";
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface TransportCallbacks {
  onPhase?: (phase: AppPhase) => void;
  onProgress?: (progress: TransferProgress) => void;
  onDiagnostic?: (event: DiagnosticEvent) => void;
  onDisconnected?: (reason?: unknown) => void;
}

export interface BleTransport {
  connect(signal?: AbortSignal): Promise<ConnectionInfo>;
  disconnect(): void;
  isConnected(): boolean;
  handshake(signal?: AbortSignal): Promise<void>;
  clear(color: "white" | "black", signal?: AbortSignal): Promise<void>;
  upload(
    image: Pick<ProcessedImage, "blackWhite" | "yellow">,
    options: TransferOptions,
    signal?: AbortSignal,
  ): Promise<ActiveTransferMode>;
  setCallbacks(callbacks: TransportCallbacks): void;
}

export interface AppSnapshot {
  phase: AppPhase;
  connection: ConnectionInfo | null;
  processedImage: ProcessedImage | null;
  progress: TransferProgress | null;
  diagnostics: readonly DiagnosticEvent[];
  errorMessage: string | null;
}

