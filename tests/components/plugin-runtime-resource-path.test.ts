import { describe, expect, it, vi } from "vitest";
import { convertPluginRuntimeResourceUrl } from "../../src/lib/pluginRuntimeResourcePath";

const root = "/plugins/sample";
const convertFileSrc = (path: string) => `asset://localhost${path}`;

describe("runtime plugin resource URL resolution", () => {
  it("resolves root-relative and based dynamic requests within the selected package", () => {
    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "pages/index.html",
      documentKind: "main",
      resourceUrl: "/assets/img.png?size=2#preview",
      convertFileSrc,
    })).toBe(`asset://localhost${root}/assets/img.png?size=2#preview`);

    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "pages/index.html",
      documentKind: "main",
      resourceUrl: "./logo.png",
      baseUrl: "./runtime/",
      convertFileSrc,
    })).toBe(`asset://localhost${root}/pages/runtime/logo.png`);

    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "pages/index.html",
      documentKind: "main",
      resourceUrl: "logo.png",
      baseUrl: "/assets/",
      convertFileSrc,
    })).toBe(`asset://localhost${root}/assets/logo.png`);
  });

  it("fails closed for a local runtime path or base escaping the package", () => {
    const convert = vi.fn(convertFileSrc);
    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "pages/index.html",
      documentKind: "main",
      resourceUrl: "../../../../private.png",
      convertFileSrc: convert,
    })).toBeNull();
    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "pages/index.html",
      documentKind: "main",
      resourceUrl: "logo.png",
      baseUrl: "../../../../outside/",
      convertFileSrc: convert,
    })).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it("preserves external URLs and suffixes without treating them as package paths", () => {
    const convert = vi.fn(convertFileSrc);
    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "index.html",
      documentKind: "main",
      resourceUrl: "https://example.test/image.png?x=1",
      convertFileSrc: convert,
    })).toBe("https://example.test/image.png?x=1");
    expect(convert).not.toHaveBeenCalled();
  });

  it("uses frame identity, not slash shape, to preserve BrowserWindow physical paths", () => {
    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "index.html",
      documentKind: "main",
      resourceUrl: "/assets/img.png",
      convertFileSrc,
    })).toBe(`asset://localhost${root}/assets/img.png`);

    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "index.html",
      documentKind: "browserWindow",
      resourceUrl: "/assets/img.png",
      convertFileSrc,
    })).toBe("asset://localhost/assets/img.png");
    expect(convertPluginRuntimeResourceUrl({
      pluginRoot: root,
      mainUrl: "index.html",
      documentKind: "browserWindow",
      resourceUrl: "/Users/me/selected/image.png",
      convertFileSrc,
    })).toBe("asset://localhost/Users/me/selected/image.png");
  });
});
