import { describe, expect, it } from "vitest";
import { preparePluginNativeWindowDocument } from "../../src/lib/pluginNativeBrowserWindowDocument";
import { findActiveHtmlScriptSpans, findActiveHtmlStyleTargets } from "../../src/lib/pluginHtmlScripts";
import { rewritePluginNativeWindowHtmlStyles } from "../../src/lib/pluginNativeWindowHtmlStyles";

const root = "/tmp/plugins/snipaste";
const session = "6fd849f2-c8f4-4fb9-91b3-2b9e65c44f1b";
const origin = "atools-plugin://localhost";

describe("native plugin HTML style preprocessing", () => {
  it("scans only active style targets and preserves the existing script scanner contract", () => {
    const html = "<!-- <style>.comment { -webkit-app-region: drag }</style> --><script>const fake = '<style>.script { -webkit-app-region: drag }</style>';</script><template><style>.template { -webkit-app-region: drag }</style></template><style>.active { -webkit-app-region: drag }</style><div style=\"-webkit-app-region: drag\"></div>";
    expect(findActiveHtmlStyleTargets(html)).toHaveLength(2);
    const scripts = findActiveHtmlScriptSpans(html);
    expect(scripts).toHaveLength(1);
    expect(html.slice(scripts[0].contentStart, scripts[0].contentEnd)).toContain("const fake");
    expect(rewritePluginNativeWindowHtmlStyles(html)).toContain(".active { --atools-native-app-region: drag }");
    expect(rewritePluginNativeWindowHtmlStyles(html)).toContain(".script { -webkit-app-region: drag }");
    expect(rewritePluginNativeWindowHtmlStyles(html)).toContain(".template { -webkit-app-region: drag }");
    expect(rewritePluginNativeWindowHtmlStyles('<main style="-webkit-app-region: drag"></main>'))
      .toBe('<main style="--atools-native-app-region: drag"></main>');
    expect(rewritePluginNativeWindowHtmlStyles('<main style="-webkit-app-region&#58; drag !important"></main>'))
      .toBe('<main style="--atools-native-app-region: drag !important"></main>');
  });

  it("rewrites inline style blocks and entity-decoded style attributes only", async () => {
    const html = "<!doctype html><main style=\"-webkit-app-region&#58; drag !important\"><style>@layer shell { #drag { -webkit-app-region: drag; } }</style><script>const fake = '<style>.x { -webkit-app-region: drag }</style>';</script><template><div style=\"-webkit-app-region: drag\"></div></template><!-- <div style=\"-webkit-app-region: drag\"> --> text</main>";
    const result = await preparePluginNativeWindowDocument({
      pluginRoot: root,
      mainUrl: "index.html",
      requestedUrl: "paster.html",
      resourceSessionId: session,
      resourceOrigin: origin,
      readTextFile: async () => html,
    });

    expect(result.html).toContain("--atools-native-app-region: drag !important");
    expect(result.html).toContain("--atools-native-app-region: drag; }");
    expect(result.html).toContain("const fake = '<style>.x { -webkit-app-region: drag }</style>';");
    expect(result.html).toContain("<template><div style=\"-webkit-app-region: drag\"></div></template>");
    expect(result.html).toContain("<!-- <div style=\"-webkit-app-region: drag\"> -->");
  });

  it("rewrites package stylesheet links after inlining without modifying source assets", async () => {
    const html = '<link rel="stylesheet" href="styles/paster.css"><div id="drag-surface"></div>';
    const css = "@layer paster { #drag-surface { -webkit-app-region: drag; } }";
    const source = new Map([["paster.html", html], ["styles/paster.css", css]]);
    const result = await preparePluginNativeWindowDocument({
      pluginRoot: root,
      mainUrl: "index.html",
      requestedUrl: "paster.html",
      resourceSessionId: session,
      resourceOrigin: origin,
      readTextFile: async path => source.get(path.slice(root.length + 1)) ?? "",
    });

    expect(result.html).toContain("--atools-native-app-region: drag;");
    expect(result.html).toContain("data-atools-plugin-href=\"styles/paster.css\"");
    expect(source.get("paster.html")).toBe(html);
    expect(source.get("styles/paster.css")).toBe(css);
  });

  it("joins many independent style edits in source order", () => {
    const input = Array.from({ length: 256 }, (_, index) =>
      `<i id="${index}" style="-webkit-app-region: drag"></i>`,
    ).join("");
    const rewritten = rewritePluginNativeWindowHtmlStyles(input);

    expect(rewritten.match(/--atools-native-app-region: drag/g)).toHaveLength(256);
    expect(rewritten.indexOf('id="0"')).toBeLessThan(rewritten.indexOf('id="255"'));
  });

  it("rewrites rawtext-element style attributes but leaves their text opaque", () => {
    const input = '<div style="-webkit-app-region: drag"><textarea style="app-region: no-drag"><style>.fake { -webkit-app-region: drag }</style></textarea></div>';
    const rewritten = rewritePluginNativeWindowHtmlStyles(input);

    expect(findActiveHtmlStyleTargets(input)).toHaveLength(2);
    expect(rewritten).toContain('<textarea style="--atools-native-app-region: no-drag">');
    expect(rewritten).toContain("<style>.fake { -webkit-app-region: drag }</style>");
  });

  it("uses HTML attribute-context character-reference rules", () => {
    const input = '<i id="copy" style="color:&copy;;app-region:no-drag"></i><i id="amp" style="color:&amp=tail;app-region:no-drag"></i><i id="legacy" style="color:&copy=tail;app-region:no-drag"></i>';
    const rewritten = rewritePluginNativeWindowHtmlStyles(input);
    const template = document.createElement("template");
    template.innerHTML = rewritten;

    expect(template.content.querySelector("#copy")?.getAttribute("style"))
      .toBe("color:©;--atools-native-app-region:no-drag");
    expect(template.content.querySelector("#amp")?.getAttribute("style"))
      .toBe("color:&amp=tail;--atools-native-app-region:no-drag");
    expect(template.content.querySelector("#legacy")?.getAttribute("style"))
      .toBe("color:&copy=tail;--atools-native-app-region:no-drag");
  });
});
