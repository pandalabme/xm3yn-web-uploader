import { PANEL_HEIGHT, PANEL_WIDTH, PLANE_BYTE_LENGTH, type ProcessedImage } from "../contracts";

export function encodePlanes(rgba: ArrayLike<number>, width = PANEL_WIDTH, height = PANEL_HEIGHT): Pick<ProcessedImage, "blackWhite" | "yellow"> {
  if (width !== PANEL_WIDTH || height !== PANEL_HEIGHT || rgba.length !== width * height * 4) throw new RangeError("平面编码要求 296 × 152 RGBA 图像。");
  const blackWhite = new Uint8Array(PLANE_BYTE_LENGTH), yellow = new Uint8Array(PLANE_BYTE_LENGTH);
  let index = 0;
  for (let x = width - 1; x >= 0; x--) {
    for (let y0 = 0; y0 < height; y0 += 8) {
      let bw = 0, yy = 0;
      for (let bit = 0; bit < 8; bit++) {
        const p = ((y0 + bit) * width + x) * 4;
        const r = rgba[p]!, g = rgba[p + 1]!, b = rgba[p + 2]!;
        bw = (bw << 1) | (r === 0 && g === 0 && b === 0 ? 0 : 1);
        yy = (yy << 1) | (r === 255 && g === 255 && b === 0 ? 1 : 0);
      }
      blackWhite[index] = bw; yellow[index] = yy; index++;
    }
  }
  return { blackWhite, yellow };
}
