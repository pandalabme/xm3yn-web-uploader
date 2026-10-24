import type { AppSnapshot } from "./contracts";
import { WebBluetoothAdapter } from "./ble/web-bluetooth-adapter";
import { processImageFile } from "./image/transform";
import { AppController } from "./app-controller";
import { createDiagnosticReport, exportReportJson } from "./diagnostics/export-report";
import { createAppView } from "./ui/view";
import { NRF_FAST_MACRO_FILENAME, NRF_MACRO_MIME_TYPE, buildFastNrfMacro } from "./macro/build-nrf-xml";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Uploader app root was not found.");

let renderSnapshot = (_snapshot: AppSnapshot): void => undefined;
const controller = new AppController({
  transport: new WebBluetoothAdapter(),
  processImage: processImageFile,
  onSnapshot: (snapshot) => renderSnapshot(snapshot),
  onExport: exportSnapshot,
  onExportMacro: exportMacro,
});
const view = createAppView(root, controller.getActions());
renderSnapshot = (snapshot) => view.render(snapshot);
view.render(controller.getSnapshot());

function exportSnapshot(snapshot: AppSnapshot): void {
  const bluetoothNavigator = navigator as Navigator & { bluetooth?: unknown };
  const report = createDiagnosticReport({
    app: { name: "XM3YN Web Uploader", version: "0.1.0" },
    browser: {
      userAgent: navigator.userAgent,
      secureContext: window.isSecureContext,
      webBluetoothAvailable: bluetoothNavigator.bluetooth !== undefined,
      platform: navigator.platform,
    },
    device: snapshot.connection ? {
      name: snapshot.connection.deviceName,
      profileId: snapshot.connection.profileId,
      id: snapshot.connection.deviceId,
    } : null,
    events: snapshot.diagnostics,
  });
  const blob = new Blob([exportReportJson(report)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `xm3yn-diagnostics-${new Date().toISOString().replace(/:/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportMacro(snapshot: AppSnapshot): void {
  if (!snapshot.processedImage) return;
  const xml = buildFastNrfMacro(snapshot.processedImage);
  download(new Blob([xml], { type: NRF_MACRO_MIME_TYPE }), NRF_FAST_MACRO_FILENAME);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

