import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeImageFile } from "../../src/image/transform";

describe("image decoding compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back when Chrome 78 rejects the from-image orientation option", async () => {
    const bitmap = { width: 296, height: 152, close: () => undefined } as ImageBitmap;
    const decode = vi.fn()
      .mockRejectedValueOnce(new TypeError("from-image is not a valid enum value"))
      .mockResolvedValueOnce(bitmap);
    vi.stubGlobal("createImageBitmap", decode);

    await expect(decodeImageFile(new Blob(["image"]))).resolves.toBe(bitmap);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls[1]).toHaveLength(1);
  });

  it("reports the legacy decoder failure when both attempts fail", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn()
      .mockRejectedValueOnce(new TypeError("unsupported option"))
      .mockRejectedValueOnce(new Error("bad jpeg")));

    await expect(decodeImageFile(new Blob(["bad"]))).rejects.toThrow("无法解码所选图片：bad jpeg");
  });
});
