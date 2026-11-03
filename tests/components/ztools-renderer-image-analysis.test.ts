import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import {
  analyzeRgbaPixels,
  createRendererImageAnalyzer,
} from "../../packages/ztools-renderer/src/imageAnalysis";
import { validateImagePayload } from "../../packages/ztools-renderer/src/imagePayloadGuard";
import type {
  RendererHostCommand,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

function pixels(width: number, height: number, fill: (pixel: number) => [number, number, number, number]) {
  const result = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    result.set(fill(pixel), pixel * 4);
  }
  return result;
}

describe("renderer image analysis", () => {
  it("classifies transparent, uniform dark icons from Canvas RGBA bytes", () => {
    const rgba = pixels(40, 40, (pixel) => pixel < 1_400
      ? [18, 36, 58, 255]
      : [0, 0, 0, 0]);

    expect(analyzeRgbaPixels(rgba, 40, 40)).toEqual({
      isSimpleIcon: true,
      mainColor: "#12243a",
      isDark: true,
      needsAdaptation: true,
    });
  });

  it("uses the original bounded sampling stride and treats alpha 20 as transparent", () => {
    const rgba = pixels(80, 40, (pixel) => {
      if (pixel % 2 === 1) return [240, 10, 10, 255];
      return pixel / 2 < 1_400 ? [240, 240, 240, 255] : [2, 3, 4, 20];
    });

    expect(analyzeRgbaPixels(rgba, 80, 40)).toEqual({
      isSimpleIcon: true,
      mainColor: "#f0f0f0",
      isDark: false,
      needsAdaptation: true,
    });
  });

  it("keeps opaque images and low-alpha-only buffers on the neutral result", () => {
    const opaque = pixels(32, 32, () => [12, 34, 56, 255]);
    const faint = pixels(32, 32, () => [12, 34, 56, 20]);
    const neutral = {
      isSimpleIcon: false,
      mainColor: null,
      isDark: false,
      needsAdaptation: false,
    };

    expect(analyzeRgbaPixels(opaque, 32, 32)).toEqual(neutral);
    expect(analyzeRgbaPixels(faint, 32, 32)).toEqual(neutral);
  });

  it("rejects invalid buffers and pixel counts above the decode budget", () => {
    expect(() => analyzeRgbaPixels(new Uint8Array(4), 0, 1)).toThrow(RangeError);
    expect(() => analyzeRgbaPixels(new Uint8Array(0), 2_049, 1_024)).toThrow(RangeError);
    expect(() => analyzeRgbaPixels(new Uint8Array(4), 2, 1)).toThrow(RangeError);
  });

  it("rejects oversized declared PNG dimensions before browser decode", async () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    header.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
    const view = new DataView(header.buffer);
    view.setUint32(16, 5_000, false);
    view.setUint32(20, 5_000, false);
    const encoded = btoa(String.fromCharCode(...header));
    const analyzer = createRendererImageAnalyzer();

    await expect(analyzer.analyze(`data:image/png;base64,${encoded}`)).resolves.toEqual({
      isSimpleIcon: false,
      mainColor: null,
      isDark: false,
      needsAdaptation: false,
    });
    expect(analyzer.snapshot().failures).toEqual({ pixel_budget: 1 });
    analyzer.dispose();
  });

  it("rejects a PNG header whose IHDR length is not 13 bytes", () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    header.set([0x00, 0x00, 0x00, 0x0c, 0x49, 0x48, 0x44, 0x52], 8);
    new DataView(header.buffer).setUint32(16, 1, false);
    new DataView(header.buffer).setUint32(20, 1, false);
    expect(() => validateImagePayload(header, "image/png")).toThrow("invalid_data_image");
  });

  it("allows local SVG icons but rejects external and entity-obfuscated SVG loads", () => {
    const safeSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect fill="#fff"/></svg>');
    const externalSvg = new TextEncoder().encode('<svg><image href="https://outside.example/x.png"/></svg>');
    const encodedImport = new TextEncoder().encode('<svg><style>&#64;import "https://outside.example/x.css";</style></svg>');
    const oversizedSvg = new TextEncoder().encode('<svg width="5000" height="5000"/>');

    expect(() => validateImagePayload(safeSvg, "image/svg+xml")).not.toThrow();
    expect(() => validateImagePayload(externalSvg, "image/svg+xml")).toThrow("unsupported_source");
    expect(() => validateImagePayload(encodedImport, "image/svg+xml")).toThrow("unsupported_source");
    expect(() => validateImagePayload(oversizedSvg, "image/svg+xml")).toThrow("pixel_budget");
  });

  it("keeps image analysis local and refuses cross-origin URLs without native IPC", async () => {
    const calls: RendererHostCommand[] = [];
    const transport: ZToolsRendererTransport = {
      async invoke(command) {
        calls.push(command);
        throw new Error("image analysis must not invoke native commands");
      },
      async listen() {
        throw new Error("image analysis must not subscribe to native events");
      },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });

    await expect(adapter.api.analyzeImage("https://outside.example/icon.png")).resolves.toEqual({
      isSimpleIcon: false,
      mainColor: null,
      isDark: false,
      needsAdaptation: false,
    });
    await expect(adapter.api.analyzeImage("data:image/webp;base64,AAAA")).resolves.toEqual({
      isSimpleIcon: false,
      mainColor: null,
      isDark: false,
      needsAdaptation: false,
    });
    expect(adapter.capabilities().methods.analyzeImage).toBe("local_only");
    expect(adapter.snapshot().imageAnalysis.failures).toEqual({ unsupported_source: 2 });
    expect(calls).toEqual([]);
    adapter.dispose();
  });

  it("fetches only absolute assets from the current scheme, host, and asset directory", async () => {
    const requests: Array<{ url: string; mode: RequestMode | undefined }> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), mode: init?.mode });
      return Promise.reject(new Error("rejected asset must never start a fetch"));
    });
    const analyzer = createRendererImageAnalyzer();
    const page = new URL(window.location.href);
    const allowedAsset = new URL("/assets/default-avatar.png", page).href;
    const outsideAssetDirectory = new URL("/profile/avatar.png", page).href;
    const otherScheme = new URL(`https://${page.host}/assets/default-avatar.png`).href;

    try {
      await expect(analyzer.analyze(allowedAsset)).resolves.toEqual({
        isSimpleIcon: false,
        mainColor: null,
        isDark: false,
        needsAdaptation: false,
      });
      for (const url of [outsideAssetDirectory, otherScheme, "https://outside.example/assets/icon.png", "file:///Users/example/assets/icon.png"]) {
        await expect(analyzer.analyze(url)).resolves.toEqual({
          isSimpleIcon: false,
          mainColor: null,
          isDark: false,
          needsAdaptation: false,
        });
      }
      expect(requests).toEqual([{ url: allowedAsset, mode: "same-origin" }]);
      expect(analyzer.snapshot().failures).toEqual({ decode_failed: 1, unsupported_source: 4 });
    } finally {
      analyzer.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("fetches only exact app icon URLs through CORS", async () => {
    const requests: Array<{ url: string; mode: RequestMode | undefined }> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), mode: init?.mode });
      return Promise.reject(new Error("rejected app icon must never start a fetch"));
    });
    const analyzer = createRendererImageAnalyzer();
    const id = "a".repeat(64);
    const allowed = [
      `atools-app-icon://localhost/${id}.png`,
      `http://atools-app-icon.localhost/${id}.png`,
      `https://atools-app-icon.localhost/${id}.png`,
    ];
    const rejected = [
      `ATools-app-icon://localhost/${id}.png`,
      `atools-app-icon://LOCALHOST/${id}.png`,
      `atools-app-icon://localhost/${id.toUpperCase()}.png`,
      `https://atools-app-icon.localhost:443/${id}.png`,
      `https://user@atools-app-icon.localhost/${id}.png`,
      `https://atools-app-icon.localhost/${id}.png?x=1`,
      `https://atools-app-icon.localhost/${id}.png#icon`,
      `https://atools-app-icon.localhost/%61${id.slice(1)}.png`,
      `https://other.localhost/${id}.png`,
      `data:text/plain,${id}`,
    ];

    try {
      for (const url of allowed) {
        await expect(analyzer.analyze(url)).resolves.toEqual({
          isSimpleIcon: false,
          mainColor: null,
          isDark: false,
          needsAdaptation: false,
        });
      }
      for (const url of rejected) {
        await expect(analyzer.analyze(url)).resolves.toEqual({
          isSimpleIcon: false,
          mainColor: null,
          isDark: false,
          needsAdaptation: false,
        });
      }
      expect(requests).toEqual(allowed.map((url) => ({ url, mode: "cors" })));
      expect(analyzer.snapshot().failures).toEqual({
        decode_failed: allowed.length,
        unsupported_source: rejected.length,
      });
    } finally {
      analyzer.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("keeps opaque Tauri origins on their scheme and host while rejecting file URLs", async () => {
    const requests: string[] = [];
    vi.stubGlobal("window", { location: { href: "tauri://localhost/index.html" } });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const analyzer = createRendererImageAnalyzer();
    const assetUrl = "tauri://localhost/assets/default-avatar.png";

    try {
      const pending = analyzer.analyze(assetUrl);
      expect(requests).toEqual([assetUrl]);

      for (const url of [
        "file:///assets/icon.png",
        "https://localhost/assets/icon.png",
        "tauri://other-host/assets/icon.png",
      ]) {
        await expect(analyzer.analyze(url)).resolves.toEqual({
          isSimpleIcon: false,
          mainColor: null,
          isDark: false,
          needsAdaptation: false,
        });
      }
      expect(requests).toEqual([assetUrl]);
      expect(analyzer.snapshot().failures).toEqual({ unsupported_source: 3 });

      vi.stubGlobal("window", { location: { href: "file:///Users/example/app/index.html" } });
      await expect(analyzer.analyze("file:///assets/icon.png")).resolves.toEqual({
        isSimpleIcon: false,
        mainColor: null,
        isDark: false,
        needsAdaptation: false,
      });
      expect(requests).toEqual([assetUrl]);

      analyzer.dispose();
      await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    } finally {
      analyzer.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("aborts in-flight asset reads and rejects work after disposal", async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal as AbortSignal;
      observedSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const analyzer = createRendererImageAnalyzer();
    const pending = analyzer.analyze("/assets/icon.png");
    try {
      expect(observedSignal).toBeDefined();
      analyzer.dispose();

      await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
      expect(observedSignal?.aborted).toBe(true);
      expect(analyzer.snapshot().cacheEntries).toBe(0);
      await expect(analyzer.analyze("/assets/icon.png")).rejects.toMatchObject({
        code: "ERR_ATOOLS_ZTOOLS_DISPOSED",
      });
    } finally {
      analyzer.dispose();
      vi.unstubAllGlobals();
    }
  });
});
