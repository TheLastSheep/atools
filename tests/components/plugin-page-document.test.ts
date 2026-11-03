import { describe, expect, it, vi } from "vitest";
import { createPluginPageDocument, pluginPageResourceUrl, validatePreparedPluginPage, type PreparedPluginPage } from "../../src/lib/pluginPageDocument";

const id = "12345678-1234-4234-9234-123456789abc";
const origin = `atools-page://${id.replaceAll("-", "")}.localhost`;
const page: PreparedPluginPage = { pageDocumentId: id, expectedOrigin: origin, parentOrigin: "atools-panel://localhost",
  bootstrapUrl: `${origin}/${"b".repeat(32)}/bootstrap.html`, resourceBaseUrl: `${origin}/assets/` };
const options = { pluginId: "file-tree", pluginRoot: "/private/fixture/plugin", parentOrigin: page.parentOrigin, isCurrent: () => true };

describe("native plugin page ownership", () => {
  it("accepts only the native instance origin, exact parent and bounded bootstrap route", () => {
    expect(Object.isFrozen(validatePreparedPluginPage(page, page.parentOrigin))).toBe(true);
    for (const changed of [{ expectedOrigin: "https://other.example" }, { pageDocumentId: crypto.randomUUID() },
      { parentOrigin: "null" }, { resourceBaseUrl: origin + "/" }, { bootstrapUrl: page.bootstrapUrl + "?reuse=true" },
      { bootstrapUrl: page.bootstrapUrl.replace(".localhost", ".localhost:1234") }, { bootstrapUrl: origin + "/index.html" }]) {
      expect(() => validatePreparedPluginPage({ ...page, ...changed }, page.parentOrigin)).toThrow("ERR_ATOOLS_PAGE_IDENTITY");
    }
  });

  it("uses same-origin package assets, including a directory base, and rejects escapes", () => {
    expect(pluginPageResourceUrl(page, options.pluginRoot, options.pluginRoot + "/")).toBe(page.resourceBaseUrl);
    expect(pluginPageResourceUrl(page, options.pluginRoot, options.pluginRoot + "/sub folder/a.png")).toBe(page.resourceBaseUrl + "sub%20folder/a.png");
    expect(pluginPageResourceUrl(page, options.pluginRoot, options.pluginRoot + "/src/")).toBe(page.resourceBaseUrl + "src/");
    expect(() => pluginPageResourceUrl(page, options.pluginRoot, "/private/fixture/other/a.png")).toThrow("ERR_ATOOLS_RESOURCE_OUTSIDE_PLUGIN");
    expect(() => pluginPageResourceUrl(page, options.pluginRoot, options.pluginRoot + "/%2e%2e/a.png")).toThrow();
  });

  it("binds all four actual prepare commands to the one native document without exposing HTML", async () => {
    const invoke = vi.fn(async (command: string) => command === "prepare_plugin_page" ? page : {});
    const document = createPluginPageDocument({ ...options, invoke: invoke as never });
    await expect(document.invoke("prepare_legacy_node")).rejects.toThrow("ERR_ATOOLS_PAGE_CANCELLED");
    await document.prepare();
    for (const command of ["prepare_legacy_node", "prepare_host_clipboard", "prepare_plugin_data", "prepare_plugin_dialogs"]) {
      await document.invoke(command, { pluginId: options.pluginId, instanceId: "runtime-instance", pageDocumentId: "spoof" });
      expect(invoke).toHaveBeenLastCalledWith(command, { pluginId: options.pluginId, instanceId: "runtime-instance", pageDocumentId: id });
    }
    await document.claim();
    expect(invoke).toHaveBeenLastCalledWith("claim_plugin_page", { pluginId: options.pluginId, instanceId: document.instanceId, pageDocumentId: id });
    expect(invoke.mock.calls.some(call => JSON.stringify(call).includes("payloadHtml"))).toBe(false);
    await document.close();
    await expect(document.claim()).rejects.toThrow("ERR_ATOOLS_PAGE_CANCELLED");
  });

  it("cancels the owner before prepare finishes and drains a late native document again", async () => {
    let finish!: (value: PreparedPluginPage) => void;
    const invoke = vi.fn((command: string) => command === "prepare_plugin_page" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const document = createPluginPageDocument({ ...options, invoke: invoke as never });
    const pending = document.prepare();
    const failed = expect(pending).rejects.toThrow("ERR_ATOOLS_PAGE_CANCELLED");
    await document.close();
    expect(invoke).toHaveBeenLastCalledWith("close_plugin_page", { pluginId: options.pluginId, instanceId: document.instanceId });
    finish(page); await failed;
    expect(invoke).toHaveBeenLastCalledWith("close_plugin_page", { pluginId: options.pluginId, instanceId: document.instanceId, pageDocumentId: id });
  });

  it("closes an allocated owner when native metadata is invalid and cannot retry that document", async () => {
    const invoke = vi.fn(async (command: string) => command === "prepare_plugin_page" ? { ...page, parentOrigin: "null" } : {});
    const document = createPluginPageDocument({ ...options, invoke: invoke as never });
    await expect(document.prepare()).rejects.toThrow("ERR_ATOOLS_PAGE_IDENTITY");
    expect(invoke).toHaveBeenLastCalledWith("close_plugin_page", { pluginId: options.pluginId, instanceId: document.instanceId });
    await expect(document.prepare()).rejects.toThrow("ERR_ATOOLS_PAGE_CANCELLED");
  });
});
