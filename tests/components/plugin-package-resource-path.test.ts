import { describe, expect, it, vi } from "vitest";
import {
  resolvePluginPackageMainPath,
  resolvePluginPackageMainUrl,
  resolvePluginPackageResourcePath,
} from "../../src/lib/pluginPackageResourcePath";
import { pluginResourceFilePath, preparePluginHtmlResources } from "../../src/lib/pluginResourceHtml";
import { createPluginResourceLease } from "../../src/lib/pluginResourceLease";

const root = "/plugins/example";
const main = `${root}/pages/index.html`;

describe("package-root plugin resource URLs", () => {
  it("maps root URLs to the selected package and relatives beside the physical main file", () => {
    expect(resolvePluginPackageMainUrl(root, "/index.html")).toBe(`${root}/index.html`);
    expect(resolvePluginPackageMainUrl(root, "pages/index.html")).toBe(main);
    expect(resolvePluginPackageMainUrl(root, main)).toBe(`${root}${main}`);
    expect(resolvePluginPackageMainPath(root, main)).toBe(main);
    expect(resolvePluginPackageMainPath(root, `${root}/../outside/index.html`)).toBeNull();
    expect(resolvePluginPackageMainUrl(root, "/../outside/index.html")).toBeNull();
    expect(resolvePluginPackageResourcePath(root, main, "/assets/js/app.js?v=1#entry"))
      .toBe(`${root}/assets/js/app.js`);
    expect(resolvePluginPackageResourcePath(root, main, "./child.js"))
      .toBe(`${root}/pages/child.js`);
    expect(resolvePluginPackageResourcePath(root, main, "../shared.css"))
      .toBe(`${root}/shared.css`);
    expect(resolvePluginPackageResourcePath("C:\\plugins\\example", "C:\\plugins\\example\\index.html", "/assets/app.js"))
      .toBe("C:/plugins/example/assets/app.js");
    expect(resolvePluginPackageMainUrl("C:\\plugins\\example", "/index.html"))
      .toBe("C:/plugins/example/index.html");
    expect(resolvePluginPackageResourcePath(root, main, "icons/logo%20small.png"))
      .toBe(`${root}/pages/icons/logo small.png`);
  });

  it("rejects package escape, encoded separators, UNC, drive paths, and controls", () => {
    for (const value of [
      "../../../../private.txt", "/../../private.txt", "assets/%2e%2e/%2e%2e/%2e%2e/private.txt",
      "assets/a%2fb.js", "assets/a%5cb.js", "//server/share/file", "C:\\Windows\\secret.js", "assets/\u0001.js",
    ]) {
      expect(resolvePluginPackageResourcePath(root, main, value), value).toBeNull();
    }
    expect(resolvePluginPackageMainUrl(root, "//server/share/index.html")).toBeNull();
    expect(resolvePluginPackageMainUrl(root, "C:\\outside\\index.html")).toBeNull();
    expect(resolvePluginPackageMainPath(root, "C:\\outside\\index.html")).toBeNull();
    expect(resolvePluginPackageResourcePath(root, "/outside/index.html", "asset.js")).toBeNull();
  });

  it("resolves a manifest root main URL and keeps physical paths explicitly separate", async () => {
    const readTextFile = vi.fn(async () => "<main>ok</main>");
    const prepared = await preparePluginHtmlResources("<main>ok</main>", {
      pluginDir: root, pluginRoot: root, mainFile: "/index.html", readTextFile,
      convertFileSrc: path => `asset://localhost${path}`,
    });
    expect(prepared).toBe("<main>ok</main>");
    expect(readTextFile).not.toHaveBeenCalled();

    await expect(preparePluginHtmlResources("", {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: "/outside/index.html",
      readTextFile, convertFileSrc: path => path,
    })).rejects.toThrow("ERR_ATOOLS_PLUGIN_MAIN_PATH");
  });

  it("rewrites HTML, CSS, and nested module URLs against the selected root", async () => {
    const readTextFile = vi.fn(async (path: string) => path.endsWith("site.css")
      ? '@import "/theme/base.css"; .logo { background: url("/assets/logo.svg") }'
      : "window.moduleLoaded = true;");
    const convertFileSrc = vi.fn((path: string) => `asset://localhost${path}`);
    const resolveModuleSrc = vi.fn(async (path: string) => `lease://localhost${path}`);
    const html = await preparePluginHtmlResources(
      '<base href="/assets/"><link rel="stylesheet" href="css/site.css"><script type="module" src="js/entry.js?v=1#main"></script>',
      { pluginDir: root, pluginRoot: root, mainFile: "pages/index.html", mainFilePath: main,
        readTextFile, convertFileSrc, resolveModuleSrc },
    );

    expect(readTextFile).toHaveBeenCalledWith(`${root}/assets/css/site.css`);
    expect(resolveModuleSrc).toHaveBeenCalledWith(`${root}/assets/js/entry.js`);
    expect(html).toContain(`lease://localhost${root}/assets/js/entry.js?v=1#main`);
    expect(html).toContain(`asset://localhost${root}/theme/base.css`);
    expect(html).toContain(`asset://localhost${root}/assets/logo.svg`);
  });

  it("sends the package-resolved physical module path through the existing resource lease", async () => {
    const token = "12345678-1234-4abc-8abc-123456789abc";
    const invoke = vi.fn(async (command: string) => command === "prepare_plugin_resources"
      ? { sessionId: token, pluginRoot: root } : undefined);
    const lease = createPluginResourceLease({ invoke: invoke as never, pluginId: "example", pluginRoot: root,
      isCurrent: () => true, convertFileSrc: () => "atools-plugin://localhost" });
    const html = await preparePluginHtmlResources('<script type="module" src="/assets/js/app.js"></script>', {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: `${root}/index.html`,
      readTextFile: vi.fn(), convertFileSrc: path => `asset://localhost${path}`,
      resolveModuleSrc: lease.resolveModuleSrc,
    });
    expect(html).toContain(`atools-plugin://localhost/${token}/assets/js/app.js`);
    expect(invoke).toHaveBeenCalledTimes(1);
    await lease.close();
  });

  it("fails closed for an escaping static resource without passing it to a loader", async () => {
    const readTextFile = vi.fn(async () => "must not read");
    const convertFileSrc = vi.fn((path: string) => `asset://localhost${path}`);
    await expect(preparePluginHtmlResources('<script src="../../../../private.js"></script>', {
      pluginDir: root, pluginRoot: root, mainFile: "pages/index.html", mainFilePath: main,
      readTextFile, convertFileSrc,
    })).rejects.toThrow("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
    expect(readTextFile).not.toHaveBeenCalled();
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  it("fails closed for escaping static scripts, stylesheets, bases, and modules", async () => {
    const readTextFile = vi.fn(async () => "must not read");
    const convertFileSrc = vi.fn((path: string) => `asset://localhost${path}`);
    for (const html of [
      '<script src="../../../../private.js"></script>',
      '<link rel="stylesheet" href="../../../../private.css">',
      '<base href="../../../../outside/"><img src="logo.png">',
    ]) {
      await expect(preparePluginHtmlResources(html, {
        pluginDir: root, pluginRoot: root, mainFile: "pages/index.html", mainFilePath: main,
        readTextFile, convertFileSrc,
      })).rejects.toThrow("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
    }
    await expect(preparePluginHtmlResources(
      '<script type="module">import "../../../../private.js";</script>', {
        pluginDir: root, pluginRoot: root, mainFile: "pages/index.html", mainFilePath: main,
        readTextFile, convertFileSrc, resolveModuleSrc: path => path,
      })).rejects.toThrow("ERR_ATOOLS_INLINE_MODULE_PATH");
    expect(readTextFile).not.toHaveBeenCalled();
    expect(convertFileSrc).not.toHaveBeenCalled();
  });

  it("does not downgrade an escaping CSS import to the original stylesheet tag", async () => {
    const readTextFile = vi.fn(async () => '@import "../../../../private.css"; .logo { background: url("/assets/logo.svg") }');
    const warn = vi.fn();
    await expect(preparePluginHtmlResources('<link rel="stylesheet" href="styles/site.css">', {
      pluginDir: root, pluginRoot: root, mainFile: "pages/index.html", mainFilePath: main,
      readTextFile, convertFileSrc: path => `asset://localhost${path}`, warn,
    })).rejects.toThrow("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
    expect(readTextFile).toHaveBeenCalledWith(`${root}/pages/styles/site.css`);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves external imports and URLs inside a package stylesheet", async () => {
    const html = await preparePluginHtmlResources('<link rel="stylesheet" href="styles/site.css">', {
      pluginDir: root, pluginRoot: root, mainFile: "pages/index.html", mainFilePath: main,
      readTextFile: async () => '@import "https://cdn.example/base.css"; .logo { background: url("https://cdn.example/logo.svg") }',
      convertFileSrc: path => `asset://localhost${path}`,
    });
    expect(html).toContain('@import "https://cdn.example/base.css"');
    expect(html).toContain('url("https://cdn.example/logo.svg")');
  });

  it("does not reinterpret existing external, data, or asset URLs", async () => {
    const html = await preparePluginHtmlResources(
      '<img src="https://example.com/a.png"><img src="data:image/png;base64,AA=="><img src="asset://localhost/a.png"><script src="https://example.com/app.js"></script><link rel="stylesheet" href="https://example.com/site.css">',
      { pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: `${root}/index.html`,
        readTextFile: vi.fn(), convertFileSrc: path => `asset://rewritten${path}` },
    );
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).toContain('src="asset://localhost/a.png"');
    expect(html).toContain('<script src="https://example.com/app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="https://example.com/site.css">');
  });

  it("keeps the legacy user absolute-file resolver behavior separate", () => {
    expect(pluginResourceFilePath(root, "index.html", "/Users/me/selected/image.png"))
      .toBe("/Users/me/selected/image.png");
  });

  it("retains absolute physical paths for user-selected BrowserWindow documents", async () => {
    const readTextFile = vi.fn(async () => "window.loaded = true;");
    const html = await preparePluginHtmlResources('<script defer src="asset.js"></script>', {
      pluginDir: root, mainFile: "/Users/me/selected/window.html", resourceResolution: "legacy",
      readTextFile, convertFileSrc: path => `asset://localhost${path}`,
    });
    expect(html).toContain('asset://localhost/Users/me/selected/asset.js');
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
