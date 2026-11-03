import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createBrowserBuffer } from "../../src/lib/browserBuffer";
import { pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { createPluginNativeImageFromBytes, validatePluginClipboardImagePayload } from "../../src/lib/pluginNativeImage";
import { createPluginNativeImageFactories } from "../../src/lib/pluginNativeImageFactories";
import { createPluginNativeImagePathFactory } from "../../src/lib/pluginNativeImagePath";

const png = new Uint8Array(readFileSync("ZTools-plugins/plugins/calculation-paper/logo.png"));

function factories(read = vi.fn(() => new Uint8Array(png))) {
  const browserBuffer = createBrowserBuffer();
  const images = createPluginNativeImageFactories(
    validatePluginClipboardImagePayload,
    createPluginNativeImageFromBytes,
    () => Buffer,
    () => browserBuffer,
  );
  const createPath = createPluginNativeImagePathFactory(read, browserBuffer, images.createFromBrowserBuffer);
  return { browserBuffer, images, createPath, read };
}

function expectCode(run: () => unknown, code: string) {
  try { run(); } catch (error) { expect((error as { code?: string }).code).toBe(code); return; }
  throw new Error(`Expected ${code}`);
}

describe("bounded PNG nativeImage.createFromPath", () => {
  it("snapshots Node bytes into BrowserBuffer before registering a writable image", () => {
    const raw = new Uint8Array(png), { browserBuffer, images, createPath, read } = factories(vi.fn(() => raw));
    const image = createPath("/tmp/ideadock/clip.png") as ReturnType<typeof createPluginNativeImageFromBytes>;
    raw.fill(0);
    expect(read).toHaveBeenCalledOnce();
    expect(browserBuffer.isBuffer(browserBuffer.from(png))).toBe(true);
    expect(image.isEmpty()).toBe(false);
    expect(image.getSize()).toEqual({ width: 200, height: 200 });
    expect(Buffer.from(image.toPNG())).toEqual(Buffer.from(png));
    expect(images.payloadForWrite(image).dataUrl).toContain("data:image/png;base64,");
  });

  it("rejects nonlocal, nul, oversized, optional-argument and missing-session requests before reading", () => {
    const { createPath, read } = factories();
    for (const value of ["relative.png", "https://example.invalid/x.png", "/tmp/a\0b.png", "/" + "x".repeat(8192)]) {
      expectCode(() => createPath(value), "ERR_ATOOLS_IMAGE_PATH_INVALID");
    }
    expectCode(() => createPath("/tmp/a.png", {}), "ERR_ATOOLS_IMAGE_PATH_INVALID");
    expect(read).not.toHaveBeenCalled();
    expectCode(() => createPluginNativeImagePathFactory(undefined, createBrowserBuffer(), () => ({}))("/tmp/a.png"),
      "ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE");
  });

  it("rejects invalid, oversized and non-PNG bytes without registering a writable image", () => {
    const oversized = vi.fn(() => new Uint8Array(512 * 1024 + 1));
    expectCode(() => factories(oversized).createPath("/tmp/large.png"), "ERR_ATOOLS_IMAGE_PATH_RESPONSE");
    const corrupt = new Uint8Array(png); corrupt[0] = 0;
    expectCode(() => factories(vi.fn(() => corrupt)).createPath("/tmp/corrupt.png"), "ERR_ATOOLS_ELECTRON_NATIVE_IMAGE");
  });

  it("routes the original Electron path call through the session reader and clipboard writer once", () => {
    const readPngPath = vi.fn(() => new Uint8Array(png));
    const writeImage = vi.fn(() => null);
    const localRequire: any = vi.fn((specifier: string) => specifier === "electron" ? { ipcRenderer: {} } : {});
    const window: any = {
      require: localRequire,
      Buffer,
      console,
      utools: { getAppName: () => "ATools", getAppVersion: () => "test" },
      __atoolsHostClipboard: { writeImage },
      __atoolsNodeModuleRequire: { readPngPath },
    };
    const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    new Function("window", script)(window);
    const electron = window.require("electron");
    const image = electron.nativeImage.createFromPath("/tmp/device-link/attachment.png");
    electron.clipboard.writeImage(image);
    expect(readPngPath).toHaveBeenCalledTimes(1);
    expect(readPngPath).toHaveBeenCalledWith("/tmp/device-link/attachment.png");
    expect(writeImage).toHaveBeenCalledOnce();
    expect(writeImage.mock.calls[0][0]).toMatchObject({ width: 200, height: 200 });
  });
});
