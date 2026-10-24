import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { PANEL_HEIGHT, PANEL_WIDTH, PLANE_BYTE_LENGTH } from "../../src/contracts";
import { encodePlanes } from "../../src/image/encode-planes";
import { quantizeRgb } from "../../src/image/quantize";

const fixtures = resolve(import.meta.dirname, "../fixtures");
const readBytes = (name: string) => readFileSync(resolve(fixtures, name));
const rgba = (color: readonly [number, number, number]) => {
  const pixels = new Uint8ClampedArray(PANEL_WIDTH * PANEL_HEIGHT * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255; }
  return pixels;
};

describe("XM3YN image pipeline", () => {
  it("encodes the Python weather preview into byte-identical planes", () => {
    const preview = PNG.sync.read(readBytes("weather_quantized_preview.png"));
    expect(preview.width).toBe(PANEL_WIDTH); expect(preview.height).toBe(PANEL_HEIGHT);
    const planes = encodePlanes(preview.data);
    expect(planes.blackWhite).toEqual(new Uint8Array(readBytes("weather_black_white.bin")));
    expect(planes.yellow).toEqual(new Uint8Array(readBytes("weather_yellow.bin")));
    expect(planes.blackWhite).toHaveLength(PLANE_BYTE_LENGTH);
    expect(planes.yellow).toHaveLength(PLANE_BYTE_LENGTH);
  });

  it.each([
    { color: [255, 255, 255] as const, bw: 0xff, yellow: 0x00 },
    { color: [0, 0, 0] as const, bw: 0x00, yellow: 0x00 },
    { color: [255, 255, 0] as const, bw: 0xff, yellow: 0xff },
  ])("encodes a uniform color $color", ({ color, bw, yellow }) => {
    const planes = encodePlanes(rgba(color));
    expect(planes.blackWhite.every((byte) => byte === bw)).toBe(true);
    expect(planes.yellow.every((byte) => byte === yellow)).toBe(true);
  });

  it("maps red to yellow and uses the Python luminance cutoff", () => {
    const samples = new Uint8ClampedArray([200, 20, 20, 255, 144, 144, 144, 255, 145, 145, 145, 255]);
    expect([...quantizeRgb(samples, 3, 1, { dither: "none", mapRedToYellow: true })]).toEqual([
      255, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });

  it("preserves native yellow even when red-to-yellow mapping is disabled", () => {
    const samples = new Uint8ClampedArray([255, 255, 0, 255, 210, 180, 80, 255]);
    expect([...quantizeRgb(samples, 2, 1, { dither: "none", mapRedToYellow: false })]).toEqual([
      255, 255, 0, 255, 255, 255, 0, 255,
    ]);
  });

  it("encodes directional corner marks with reverse columns and MSB-first vertical pixels", () => {
    const pixels = rgba([255, 255, 255]);
    const mark = (x: number, y: number, color: readonly [number, number, number]) => {
      const p = (y * PANEL_WIDTH + x) * 4; pixels[p] = color[0]; pixels[p + 1] = color[1]; pixels[p + 2] = color[2];
    };
    mark(0, 0, [0, 0, 0]); mark(PANEL_WIDTH - 1, 7, [0, 0, 0]);
    mark(0, PANEL_HEIGHT - 1, [255, 255, 0]); mark(PANEL_WIDTH - 1, PANEL_HEIGHT - 8, [255, 255, 0]);
    const { blackWhite, yellow } = encodePlanes(pixels);
    // Column x=295 starts at byte 0, then eight vertical pixels occupy bits 7..0.
    expect(blackWhite[0]).toBe(0xfe);
    expect(blackWhite[(PANEL_WIDTH - 1) * (PANEL_HEIGHT / 8)]).toBe(0x7f);
    expect(yellow[(PANEL_WIDTH - 1) * (PANEL_HEIGHT / 8) + (PANEL_HEIGHT - 8) / 8]).toBe(0x01);
    expect(yellow[(PANEL_HEIGHT - 8) / 8]).toBe(0x80);
  });
});
