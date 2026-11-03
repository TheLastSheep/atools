import { describe, expect, it, vi } from "vitest";
import { isOptionalRemoteFontMetadataLink } from "../../src/lib/optionalRemoteFontMetadata";
import { preparePluginHtmlResources } from "../../src/lib/pluginResourceHtml";

const root = "/plugins/font-fixture";
const mainFile = `${root}/index.html`;
const googleFontCss = "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=ZCOOL+KuaiLe&display=swap";

describe("optional remote font metadata adapter", () => {
  it("recognizes only bounded Google Fonts CSS and exact font preconnect metadata", () => {
    expect(isOptionalRemoteFontMetadataLink(`<link rel="stylesheet" href="${googleFontCss}">`)).toBe(true);
    expect(isOptionalRemoteFontMetadataLink('<link rel="preconnect" href="https://fonts.googleapis.com">')).toBe(true);
    expect(isOptionalRemoteFontMetadataLink('<link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin>')).toBe(true);
    expect(isOptionalRemoteFontMetadataLink('<link rel="dns-prefetch" href="https://fonts.googleapis.com">')).toBe(true);

    for (const link of [
      '<link rel="stylesheet" href="https://fonts.googleapis.com.evil/css2?family=Roboto">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/styles/site.css?family=Roboto">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto&text=hello">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com:8443/css2?family=Roboto">',
      '<link rel="stylesheet" href="https://user@fonts.googleapis.com/css2?family=Roboto">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto#fragment">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto\n&display=swap">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto" href="https://cdn.example/business.css">',
      '<link rel="stylesheet alternate" href="https://fonts.googleapis.com/css2?family=Roboto">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto" onload="run()">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto" data-owner="business">',
      '<link rel="preconnect dns-prefetch" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com/resource">',
      '<link rel="stylesheet" href="https://cdn.example/site.css">',
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${"R".repeat(2100)}">`,
      `<link rel="preconnect" href="https://fonts.googleapis.com" data-note="${"x".repeat(5000)}">`,
    ]) expect(isOptionalRemoteFontMetadataLink(link)).toBe(false);
  });

  it("removes only optional font links through the real package HTML preparation chain", async () => {
    const fontMetadata = [
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      `<link href="${googleFontCss}" rel="stylesheet">`,
    ].join("\n");
    const scriptLiteralLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=ScriptLiteral">';
    const templateLiteralLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=TemplateLiteral">';
    const commentLiteralLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=CommentLiteral">';
    const parserBoundaryLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=ParserBoundary">';
    const scriptEscapedLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=ScriptEscaped">';
    const scriptEscapedTailLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=ScriptEscapedTail">';
    const input = `<!doctype html><html><head>${fontMetadata}
      <link rel="shortcut icon" href="./assets/logo-B0a53sPy.jpg">
      <link rel="stylesheet" crossorigin href="./assets/index-DU-Q7rmw.css">
      <link rel="stylesheet" href="https://cdn.example/business.css">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto&text=business">
      <!-- ${commentLiteralLink} -->
      <template>${templateLiteralLink}</template>
      <script>const template = '${scriptLiteralLink}';</script>
      <script>const parserBoundary = "</script>${parserBoundaryLink}</script>
      <style>.font-test::after { content: '${templateLiteralLink}'; }</style>
      <textarea>${templateLiteralLink}</textarea>
      <title>${templateLiteralLink}</title>
      <noscript>${templateLiteralLink}</noscript>
      <svg>${templateLiteralLink}</svg>
      <math>${templateLiteralLink}</math>
      <script><!--<script>${scriptEscapedLink}</script>${scriptEscapedTailLink}</script>
      <script type="module" crossorigin src="./assets/index-Chfu1R0M.js"></script>
      <script src="https://cdn.example/business.js"></script>
      </head><body><p>2 < 3</p><img src="https://cdn.example/business.png"><div id="app"></div></body></html>`;
    const originalCss = "body{font-family:'Orbitron','Noto Sans SC',sans-serif}@import url(https://fonts.googleapis.com/css2?family=Roboto);";
    const reads: string[] = [];
    const readTextFile = vi.fn(async (path: string) => {
      reads.push(path);
      if (path === `${root}/assets/index-DU-Q7rmw.css`) return originalCss;
      throw new Error(`unexpected resource read: ${path}`);
    });
    const convertFileSrc = vi.fn((path: string) => `asset://localhost${path}`);
    const prepared = await preparePluginHtmlResources(input, {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: mainFile,
      readTextFile, convertFileSrc,
    });

    expect(prepared).not.toContain("fonts.googleapis.com/css2?family=Orbitron");
    expect(prepared).not.toContain("fonts.gstatic.com");
    expect(prepared).toContain("https://cdn.example/business.css");
    expect(prepared).toContain("https://fonts.googleapis.com/css2?family=Roboto&text=business");
    expect(prepared).toContain(scriptLiteralLink);
    expect(prepared).toContain(templateLiteralLink);
    expect(prepared).toContain(commentLiteralLink);
    expect(prepared).toContain(scriptEscapedLink);
    expect(prepared).toContain(scriptEscapedTailLink);
    expect(prepared).toContain("2 < 3");
    expect(prepared).not.toContain("family=ParserBoundary");
    expect(prepared).toContain(`src="asset://localhost${root}/assets/index-Chfu1R0M.js"`);
    expect(prepared).toContain(`href="asset://localhost${root}/assets/logo-B0a53sPy.jpg"`);
    expect(prepared).toContain("https://cdn.example/business.js");
    expect(prepared).toContain("https://cdn.example/business.png");
    expect(prepared).toContain("@import url(https://fonts.googleapis.com/css2?family=Roboto)");
    expect(prepared).toContain("font-family:'Orbitron','Noto Sans SC',sans-serif");
    expect(reads).toEqual([`${root}/assets/index-DU-Q7rmw.css`]);
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(convertFileSrc.mock.calls.map(([path]) => path)).toEqual([
      `${root}/assets/logo-B0a53sPy.jpg`, `${root}/assets/index-Chfu1R0M.js`,
    ]);
    expect(input).toContain(fontMetadata);
    expect(originalCss).toBe("body{font-family:'Orbitron','Noto Sans SC',sans-serif}@import url(https://fonts.googleapis.com/css2?family=Roboto);");
  });

  it("leaves all content after an HTML plaintext element untouched by the font filter", async () => {
    const textOnlyFontLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plaintext">';
    const input = `<!doctype html><html><body><plaintext>${textOnlyFontLink}`;
    const prepared = await preparePluginHtmlResources(input, {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: mainFile,
      readTextFile: vi.fn(async (_path: string) => ""), convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
    });

    expect(prepared).toContain(textOnlyFontLink);
  });

  it("preserves font-shaped text inside an unterminated tag in the real preparation chain", async () => {
    const malformedFontLink = '<link rel=stylesheet href=https://fonts.googleapis.com/css2?family=MalformedTail>';
    const malformedTail = `<div title="${malformedFontLink}`;
    const prepared = await preparePluginHtmlResources(malformedTail, {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: mainFile,
      readTextFile: vi.fn(async (_path: string) => ""), convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
    });

    expect(prepared).toContain(malformedFontLink);
  });

  it("prepares a large malformed tail in a single pass and preserves all of it", async () => {
    const malformedFontLink = '<link rel=stylesheet href=https://fonts.googleapis.com/css2?family=MalformedTail>';
    const malformedTail = `<div title="${"<a title=".repeat(12000)}${malformedFontLink}`;
    const prepared = await preparePluginHtmlResources(malformedTail, {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: mainFile,
      readTextFile: vi.fn(async (_path: string) => ""), convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
    });

    expect(prepared).toBe(malformedTail);
  });

  it("keeps font and script lookalikes inside an unknown-name tag attribute", async () => {
    const fakeFontLink = "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=CustomTagFake'>";
    const fakeScript = "<script src='./assets/fake.js'></script>";
    const customTag = `<section$ data-note="${fakeFontLink}${fakeScript}">custom</section$>`;
    const activeFontLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=ActiveAfterCustomTag">';
    const input = `<!doctype html><html><head>${customTag}${activeFontLink}</head></html>`;
    const readTextFile = vi.fn(async (_path: string) => "");
    const prepared = await preparePluginHtmlResources(input, {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: mainFile,
      readTextFile, convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
    });

    expect(prepared).toContain(customTag);
    expect(prepared).not.toContain("family=ActiveAfterCustomTag");
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("checks many short scripts independently and still removes a following active font link", async () => {
    const scripts = Array.from({ length: 96 }, (_, index) => `<script>window.shortScript${index}=true;</script>`).join("");
    const activeFontLink = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=ActiveAfterShortScripts">';
    const input = `<!doctype html><html><head>${scripts}${activeFontLink}</head></html>`;
    const prepared = await preparePluginHtmlResources(input, {
      pluginDir: root, pluginRoot: root, mainFile: "index.html", mainFilePath: mainFile,
      readTextFile: vi.fn(async (_path: string) => ""), convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
    });

    expect(prepared).toContain(scripts);
    expect(prepared).not.toContain("family=ActiveAfterShortScripts");
  });
});
