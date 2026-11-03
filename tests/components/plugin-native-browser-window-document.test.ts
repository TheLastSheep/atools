import { describe, expect, it } from "vitest";
import { appendPluginNativeWindowDocumentId, preparePluginNativeWindowDocument } from "../../src/lib/pluginNativeBrowserWindowDocument";

const root = "/tmp/plugins/snipaste";
const session = "6fd849f2-c8f4-4fb9-91b3-2b9e65c44f1b";
const origin = "atools-plugin://localhost";
const documentId = "ab".repeat(32);

describe("native BrowserWindow plugin document lease", () => {
  it("keeps package-relative HTML, rewrites local assets to the lease, and preserves plugin query and hash", async () => {
    const result = await preparePluginNativeWindowDocument({
      pluginRoot: root,
      mainUrl: "index.html",
      requestedUrl: "paster.html?id=clip-17&windowRole=floating#canvas",
      resourceSessionId: session,
      resourceOrigin: origin,
      readTextFile: async path => path.endsWith("paster.html")
        ? '<!doctype html><html><body><img src="assets/pin.png"></body></html>'
        : "asset",
    });

    expect(result.relativePath).toBe("paster.html");
    expect(result.resourceUrl).toBe(`${origin}/${session}/paster.html?id=clip-17&windowRole=floating#canvas`);
    expect(result.html).toContain(`${origin}/${session}/assets/pin.png`);
    expect(appendPluginNativeWindowDocumentId(result.resourceUrl, documentId)).toBe(
      `${origin}/${session}/paster.html?id=clip-17&windowRole=floating&__atools_window_document=${documentId}#canvas`,
    );
  });

  it("rejects token conflicts and invalid host document ids instead of changing plugin queries", () => {
    expect(() => appendPluginNativeWindowDocumentId(`${origin}/${session}/paster.html?id=7&__atools_window_document=old`, documentId))
      .toThrow("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_DOCUMENT_QUERY");
    expect(() => appendPluginNativeWindowDocumentId(`${origin}/${session}/paster.html?id=7#pin`, "not-a-document-id"))
      .toThrow("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_DOCUMENT_ID");
  });
});
