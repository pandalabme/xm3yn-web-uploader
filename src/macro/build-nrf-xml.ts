import type { ProcessedImage } from "../contracts";
import { XM3YN_E31A as profile } from "../devices/xm3yn-e31a";

type ImagePlanes = Pick<ProcessedImage, "blackWhite" | "yellow">;

// nRF Connect for Android launches ACTION_GET_CONTENT with type text/xml.
// application/xml files are filtered out by Android DocumentsUI.
export const NRF_MACRO_MIME_TYPE = "text/xml;charset=utf-8";
export const NRF_MACRO_FILENAME = "xm3yn-current-safe-nrf.xml";
export const NRF_FAST_MACRO_FILENAME = "xm3yn-current-fast-nrf.xml";

/** Builds the same safe WRITE_REQUEST stream used by the verified nRF Macro. */
export function buildSafeNrfMacro(image: ImagePlanes, name = "XM3YN web diagnostic"): string {
  return buildNrfMacro(image, profile.safePayloadBytes, name, false);
}

/** Builds the MTU-247/240-byte stream used by the verified fast nRF Macro. */
export function buildFastNrfMacro(image: ImagePlanes, name = "XM3YN web fast"): string {
  return buildNrfMacro(image, profile.fastPayloadBytes, name, true);
}

function buildNrfMacro(image: ImagePlanes, payloadBytes: number, name: string, fast: boolean): string {
  if (image.blackWhite.length !== profile.planeByteLength || image.yellow.length !== profile.planeByteLength) {
    throw new RangeError("Image plane length does not match XM3YN profile");
  }
  const lines = [
    `<macro name="${escapeXml(name)}" icon="UPLOAD">`,
    write(profile.uartServiceUuid, profile.uartCharacteristicUuid, profile.commands.enterImageMode, "切换到图片模式"),
  ];
  if (fast) {
    lines.push(
      `  <request-mtu description="请求 247 字节 MTU" value="247" />`,
      `  <request-connection-priority description="提高传输优先级" type="HIGH" />`,
    );
  }
  lines.push(
    write(profile.epdServiceUuid, profile.epdCharacteristicUuid, profile.commands.clearBuffers, "清空两块屏幕缓冲"),
    write(profile.epdServiceUuid, profile.epdCharacteristicUuid, profile.commands.resetOffset, "复位写入位置"),
  );
  for (const [label, selector, data] of [
    ["黑白", profile.planeSelectors.blackWhite, image.blackWhite],
    ["黄色", profile.planeSelectors.yellow, image.yellow],
  ] as const) {
    for (let offset = 0; offset < data.length; offset += payloadBytes) {
      const payload = data.subarray(offset, Math.min(offset + payloadBytes, data.length));
      const packet = Uint8Array.of(0x03, selector, offset >> 8, offset & 0xff, ...payload);
      lines.push(write(profile.epdServiceUuid, profile.epdCharacteristicUuid, packet, `${label}平面 ${offset.toString(16).padStart(4, "0").toUpperCase()}`));
    }
  }
  lines.push(write(profile.epdServiceUuid, profile.epdCharacteristicUuid, profile.commands.refresh, "全屏刷新"), "</macro>", "");
  return lines.join("\n");
}

function write(service: BluetoothServiceUUID, characteristic: BluetoothCharacteristicUUID, value: Uint8Array, description: string): string {
  // nRF Connect's Macro preflight in the tested Android version compares the
  // UUID text case-sensitively against its lower-case discovered UUIDs.
  return `  <write description="${escapeXml(description)}" type="WRITE_REQUEST" service-uuid="${String(service).toLowerCase()}" characteristic-uuid="${String(characteristic).toLowerCase()}" value="${hex(value)}" />`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
