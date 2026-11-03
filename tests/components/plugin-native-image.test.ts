import { describe, expect, it, vi } from "vitest";
import { createPluginNativeImage, validatePluginClipboardImagePayload } from "../../src/lib/pluginNativeImage";

const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7w8AAAAASUVORK5CYII=", "base64");
const dataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
const payload = { dataUrl, width: 1, height: 1 };

describe("bounded clipboard NativeImage facade", () => {
  it("validates exact PNG dimensions and exposes synchronous Electron methods", () => {
    expect(validatePluginClipboardImagePayload(payload)).toEqual(payload);
    const image = createPluginNativeImage(payload);
    expect(image.isEmpty()).toBe(false);
    expect(image.getSize()).toEqual({ width: 1, height: 1 });
    expect(image.toDataURL()).toBe(dataUrl);
    const first = image.toPNG();
    expect(Buffer.isBuffer(first)).toBe(true);
    expect(first).toEqual(pngBytes);
    first[0] = 0;
    expect(image.toPNG()).toEqual(pngBytes);
    expect(image.getSize()).toEqual({ width: 1, height: 1 });
    expect(() => image.toPNG({ scaleFactor: 2 })).toThrow("NativeImage.toPNG options");
    expect(() => image.toDataURL({})).toThrow("NativeImage.toDataURL options");
    expect(() => image.getSize({})).toThrow("NativeImage.getSize options");
  });

  it("maps null to an empty image without inventing pixels", () => {
    const image = createPluginNativeImage(null);
    expect(image.isEmpty()).toBe(true);
    expect(image.toDataURL()).toBe("data:image/png;base64,");
    expect(image.toPNG()).toHaveLength(0);
    expect(image.getSize()).toEqual({ width: 0, height: 0 });
  });

  it("does not trust a caller-supplied native-image factory property", () => {
    const forgedFactory = vi.fn(() => ({ isEmpty: () => false }));
    const own = { ...payload, dataUrl: "invalid" } as any;
    Object.defineProperty(own, "__atoolsCreateNativeImage", { value: forgedFactory });
    const inherited = Object.assign(Object.create({ __atoolsCreateNativeImage: forgedFactory }), own);
    expect(() => createPluginNativeImage(own)).toThrow("data URL");
    expect(() => createPluginNativeImage(inherited)).toThrow("data URL");
    expect(forgedFactory).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...payload, width: 2 }, "dimensions"],
    [{ ...payload, height: 8193 }, "supported size"],
    [{ ...payload, extra: true }, "Invalid clipboard image response"],
    [{ ...payload, dataUrl: "data:image/jpeg;base64," + pngBytes.toString("base64") }, "data URL"],
    [{ ...payload, dataUrl: "data:image/png;base64,%%%%" }, "data URL"],
  ])("rejects malformed response %#", (value, message) => {
    expect(() => validatePluginClipboardImagePayload(value)).toThrow(message as string);
  });

  it("rejects encoded bytes beyond 512 KiB before parsing image structure", () => {
    const large = Buffer.alloc(512 * 1024 + 1, 1).toString("base64");
    expect(() => validatePluginClipboardImagePayload({ dataUrl: `data:image/png;base64,${large}`, width: 1, height: 1 }))
      .toThrow("supported size");
  });

  it("accepts a near-cap PNG through the production validator and stays within the full JSON envelope budget", () => {
    const bytes = Buffer.alloc(512 * 1024);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1], 0);
    const nearCap = { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, width: 1, height: 1 };
    const facade = createPluginNativeImage(nearCap);
    const first = facade.toPNG();
    expect(Buffer.from(first)).toEqual(bytes);
    first[0] = 0;
    expect(Buffer.from(facade.toPNG())).toEqual(bytes);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, result: nearCap })) < 700 * 1024).toBe(true);
  });

  it("rejects a truncated PNG header even when signature and dimensions are present", () => {
    const truncated = pngBytes.subarray(0, 24).toString("base64");
    expect(() => validatePluginClipboardImagePayload({ dataUrl: `data:image/png;base64,${truncated}`, width: 1, height: 1 }))
      .toThrow("supported size");
  });
});
