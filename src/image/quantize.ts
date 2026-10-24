import type { DitherMode } from "../contracts";

export type RgbaPixels = Uint8ClampedArray;

export function quantizeRgb(
  rgba: RgbaPixels,
  width: number,
  height: number,
  options: { dither: DitherMode; mapRedToYellow: boolean },
): RgbaPixels {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new RangeError("RGBA 数据长度必须与正整数图像尺寸匹配。");
  }
  const output = new Uint8ClampedArray(rgba.length);
  const work = options.dither === "floyd-steinberg" ? new Float64Array(width * height * 3) : null;
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    let r = rgba[p]!, g = rgba[p + 1]!, b = rgba[p + 2]!;
    if (work) { r += work[i * 3]!; g += work[i * 3 + 1]!; b += work[i * 3 + 2]!; }
    const redArt = options.mapRedToYellow && r >= 80 && r - g >= 28 && r - b >= 28;
    const yellowArt = r >= 100 && g >= 80 && Math.min(r, g) - b >= 40;
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const color: readonly [number, number, number] = redArt || yellowArt ? [255, 255, 0] : luminance < 145 ? [0, 0, 0] : [255, 255, 255];
    output[p] = color[0]; output[p + 1] = color[1]; output[p + 2] = color[2]; output[p + 3] = 255;
    if (work) {
      const er = r - color[0], eg = g - color[1], eb = b - color[2], x = i % width, y = Math.floor(i / width);
      const spread = (nx: number, ny: number, factor: number) => {
        if (nx < 0 || nx >= width || ny >= height) return;
        const n = (ny * width + nx) * 3; work[n] = work[n]! + er * factor; work[n + 1] = work[n + 1]! + eg * factor; work[n + 2] = work[n + 2]! + eb * factor;
      };
      spread(x + 1, y, 7 / 16); spread(x - 1, y + 1, 3 / 16); spread(x, y + 1, 5 / 16); spread(x + 1, y + 1, 1 / 16);
    }
  }
  return output;
}
