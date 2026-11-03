import { describe, expect, it, vi } from "vitest";
import { preparePluginHtmlResources } from "../../src/lib/pluginResourceHtml";

const prepare = async (html: string) => {
  const readTextFile = vi.fn(async () => "window.loaded = true;");
  const result = await preparePluginHtmlResources(html, {
    pluginDir: "/plugin", mainFile: "index.html", readTextFile,
    convertFileSrc: file => `asset://localhost${file}`,
  });
  return { scripts: [...new DOMParser().parseFromString(result, "text/html").querySelectorAll("script")], readTextFile };
};

describe("native external plugin script loading", () => {
  it("keeps defer/async as external parser scripts without reading or copying their source", async () => {
    const { scripts, readTextFile } = await prepare(`<head><script defer src="a.js"></script>
      <script src="b.js" ASYNC="false" defer></script></head><body id="app"></body>`);
    expect(readTextFile).not.toHaveBeenCalled();
    expect(scripts.map(script => script.getAttribute("src"))).toEqual(["asset://localhost/plugin/a.js", "asset://localhost/plugin/b.js"]);
    expect(scripts.every(script => script.defer && !script.textContent)).toBe(true);
    expect(scripts[1].hasAttribute("async")).toBe(true);
    expect(scripts[0].getAttribute("data-atools-plugin-script-src")).toBe("asset://localhost/plugin/a.js");
  });

  it("recognizes JavaScript MIME essence and legacy spellings without mistaking data attributes for flags", async () => {
    const { scripts, readTextFile } = await prepare(`<script type="text/javascript; charset=utf-8" DeFeR src="a.js"></script>
      <script type='application/x-javascript' async src="b.js"></script><script type=text/javascript1.5 defer src="c.js"></script>
      <script data-note="async defer" src="d.js"></script>`);
    expect(scripts.slice(0, 3).every(script => script.hasAttribute("src"))).toBe(true);
    expect(scripts[3].hasAttribute("src")).toBe(false);
    expect(readTextFile).toHaveBeenCalledTimes(1);
  });

  it("preserves query/fragment bytes and the declared local base for currentScript resource resolution", async () => {
    const { scripts, readTextFile } = await prepare('<base href="./release/"><script defer nonce="keep" src="app.js?v=a%2Fb#frag"></script>');
    expect(scripts[0].getAttribute("src")).toBe("asset://localhost/plugin/release/app.js?v=a%2Fb#frag");
    expect(scripts[0].getAttribute("nonce")).toBe("keep");
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("preserves module source URLs while retaining blocking, inline, non-JavaScript and remote behavior", async () => {
    const { scripts, readTextFile } = await prepare(`<script src="blocking.js"></script><script defer>inline()</script>
      <script type="module" defer src="module.js"></script><script type="application/json" defer src="data.json"></script>
      <script defer src="https://example.com/remote.js"></script>`);
    expect(scripts[0].hasAttribute("src")).toBe(false);
    expect(scripts[0].textContent).toContain("window.loaded");
    expect(scripts[1].textContent).toBe("inline()");
    expect(scripts[2].type).toBe("module");
    expect(scripts[2].getAttribute("src")).toBe("asset://localhost/plugin/module.js");
    expect(scripts[2].textContent).toBe("");
    expect(scripts[3].type).toBe("application/json");
    expect(scripts[3].getAttribute("src")).toBe("data.json");
    expect(scripts[4].getAttribute("src")).toBe("https://example.com/remote.js");
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(readTextFile).toHaveBeenCalledWith("/plugin/blocking.js");
  });

  it("keeps module attributes, base, query and fragment without reading module source", async () => {
    const { scripts, readTextFile } = await prepare('<base href="./release/"><script TYPE="module" crossorigin="anonymous" integrity="sha256-test" nonce="keep" src="app.js?v=a%2Fb#frag"></script>');
    expect(scripts[0].getAttribute("src")).toBe("asset://localhost/plugin/release/app.js?v=a%2Fb#frag");
    expect(scripts[0].getAttribute("crossorigin")).toBe("anonymous");
    expect(scripts[0].getAttribute("integrity")).toBe("sha256-test");
    expect(scripts[0].getAttribute("nonce")).toBe("keep");
    expect(readTextFile).not.toHaveBeenCalled();
  });
});
