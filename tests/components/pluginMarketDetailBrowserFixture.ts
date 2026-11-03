import "../../src/styles/global.css";
import { mount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import PluginMarketDetailBrowserHarness from "./PluginMarketDetailBrowserHarness.svelte";
import { DEFAULT_ZTOOLS_MARKET_URL, type MarketConfirm } from "../../src/lib/pluginMarketView";
import type { PluginMarketCatalogPlugin } from "../../src/lib/types";
import { createPermissionHarnessBackend } from "./permissionHarnessBackend";

export const calls: Array<{ command: string; args: unknown }> = [];
export const confirmations: MarketConfirm[] = [];
export const unexpectedCommands: string[] = [];
export const globalKeys: string[] = [];
export const preflight = { mode: "available" as "available" | "unsupported" | "missing" | "error", version: "1.0.0" };
export const permissionBackend = createPermissionHarnessBackend();
export const plugins: PluginMarketCatalogPlugin[] = Array.from({ length: 220 }, (_, index) => ({
  id: `offline-fixture-${index + 1}`, name: index === 0 ? "颜色工具" : `样例工具 ${index + 1}`, version: "1.0.0",
  description: index === 0 ? "样例目录：在颜色格式间转换，并收藏常用色值。此页面只验证市场交互，不执行插件。" : `样例目录：离线功能说明 ${index + 1}`,
  author: "离线验证", trust_policy: "official_ztools_confirm", downloads: 1024 + index,
  homepage: `https://fixture.invalid/${"long-reference/".repeat(8)}${index + 1}`,
}));
mockWindows("main"); mockConvertFileSrc("macos");
let listenerId = 0;
mockIPC((command, args) => {
  if (command === "plugin:event|listen") return ++listenerId;
  if (command === "plugin:event|unlisten") return;
  calls.push({ command, args });
  if (command === "list_plugins") return [];
  if (command === "fetch_plugin_market_catalog") return { source_url: args?.url, source_kind: "ztools", plugins };
  if (command === "fetch_official_plugin_target") {
    if (preflight.mode === "error") throw new Error("离线预检样例：发布信息暂时不可用");
    const selected = plugins.find(plugin => plugin.id === args?.pluginId);
    const status = preflight.mode === "unsupported" ? "unsupported_platform" : preflight.mode === "missing" || !selected ? "not_found" : "available";
    return { plugin_id: args?.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status,
      plugin: status === "available" ? { ...selected, version: preflight.version } : null };
  }
  if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/__offline__/never-downloaded.zip", package_format: "zip" };
  unexpectedCommands.push(command);
  throw new Error("Offline detail fixture rejects IPC: " + command);
});
window.addEventListener("keydown", event => globalKeys.push(event.key));

export function mountFixture() {
  localStorage.clear();
  return mount(PluginMarketDetailBrowserHarness, { target: document.getElementById("app")!,
    props: { recordConfirmation: request => confirmations.push(request), permissionBackend } });
}
