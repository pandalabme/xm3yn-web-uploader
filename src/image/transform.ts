import { PANEL_HEIGHT, PANEL_WIDTH, type ImageProcessingOptions, type ProcessedImage } from "../contracts";
import { encodePlanes } from "./encode-planes";
import { quantizeRgb } from "./quantize";

export function processRgba(source: Uint8ClampedArray, width: number, height: number, options: ImageProcessingOptions): ProcessedImage {
  const rgba = quantizeRgb(source, width, height, options);
  const planes = encodePlanes(rgba, width, height);
  return { width: PANEL_WIDTH, height: PANEL_HEIGHT, previewRgba: rgba, ...planes };
}

export async function processImageFile(file: File, options: ImageProcessingOptions): Promise<ProcessedImage> {
  if (!(file instanceof Blob) || file.size === 0) throw new Error("请选择非空的图片文件。");
  if (typeof createImageBitmap !== "function") throw new Error("当前浏览器不支持图片解码（createImageBitmap）。");
  const bitmap = await decodeImageFile(file);
  try {
    const swapped = options.rotation === 90 || options.rotation === 270;
    const orientedWidth = swapped ? bitmap.height : bitmap.width, orientedHeight = swapped ? bitmap.width : bitmap.height;
    const oriented = makeCanvas(orientedWidth, orientedHeight);
    const octx = oriented.getContext("2d", { willReadFrequently: true });
    if (!octx) throw new Error("浏览器无法创建图片处理 Canvas。");
    octx.translate(orientedWidth / 2, orientedHeight / 2);
    octx.rotate(options.rotation * Math.PI / 180);
    octx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    const canvas = makeCanvas(PANEL_WIDTH, PANEL_HEIGHT), ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("浏览器无法创建预览 Canvas。");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const scale = options.fit === "cover" ? Math.max(PANEL_WIDTH / orientedWidth, PANEL_HEIGHT / orientedHeight) : Math.min(PANEL_WIDTH / orientedWidth, PANEL_HEIGHT / orientedHeight);
    const dw = orientedWidth * scale, dh = orientedHeight * scale;
    ctx.drawImage(oriented, (PANEL_WIDTH - dw) / 2, (PANEL_HEIGHT - dh) / 2, dw, dh);
    let data: ImageData;
    try { data = ctx.getImageData(0, 0, PANEL_WIDTH, PANEL_HEIGHT); }
    catch (error) { throw new Error(`无法读取 Canvas 像素：${error instanceof Error ? error.message : String(error)}`); }
    return processRgba(data.data, PANEL_WIDTH, PANEL_HEIGHT, options);
  } finally { bitmap.close(); }
}

/** Chrome 78 exposes createImageBitmap but rejects the newer from-image enum. */
export async function decodeImageFile(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (modernError) {
    try {
      return await createImageBitmap(file);
    } catch (legacyError) {
      const detail = legacyError instanceof Error ? legacyError.message
        : modernError instanceof Error ? modernError.message : String(legacyError);
      throw new Error(`无法解码所选图片：${detail}`);
    }
  }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") throw new Error("当前环境没有可用的 Canvas。");
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}
