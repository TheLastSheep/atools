import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { PluginMarketCatalog } from "../../src/lib/types";

const emptyHomeFixture = new URLSearchParams(window.location.search).get("view") === "empty-home";
const settings = { localAppSearch: false, localLaunchSearch: false, autoPaste: "never", showRecentInSearch: emptyHomeFixture };
if (emptyHomeFixture) {
  for (const key of ["atools:pinned-commands", "atools:command-history", "atools:launcher-pin-snapshots:v1"]) {
    localStorage.removeItem(key);
  }
}
const fixedCatalog: PluginMarketCatalog = {
  source_url: "https://fixture.invalid/plugins.json",
  source_kind: "ztools",
  plugins: [{ id: "fixed-market-plugin", name: "固定市场样例", version: "1.0.0",
    description: "固定的路由验收数据，不会发出网络请求", trust_policy: "official_ztools_confirm" }],
};
const calls: string[] = [];
const unexpected: string[] = [];
let nextEventId = 0;
const observation = document.getElementById("market-search-observation");
const appRoot = document.getElementById("app");
if (!observation || !appRoot) throw new Error("Market search fixture roots are missing");
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-fixture-theme]")) {
  button.addEventListener("click", () => {
    const theme = button.dataset.fixtureTheme;
    if (theme === "light" || theme === "dark") document.documentElement.dataset.atoolsTheme = theme;
  });
}

function updateObservation() {
  const query = document.querySelector<HTMLInputElement>(".search-input")?.value ?? "";
  const options = appRoot.querySelectorAll('[role="option"]').length;
  const headings = Array.from(appRoot.querySelectorAll("h2"), element => element.textContent?.trim() ?? "");
  const names = unexpected.slice(0, 6).map(name => name.slice(0, 80)).join(", ");
  const overflow = unexpected.length > 6 ? `，另有 ${unexpected.length - 6} 项` : "";
  const unexpectedStatus = unexpected.length ? `（${names}${overflow}）` : "";
  observation.textContent = `固定目录 fixture · ${emptyHomeFixture ? "空首页验收" : "市场路由验收"} · 搜索输入：${query || "空"} · 可见选项：${options} · 市场请求：${calls.filter(name => name === "fetch_plugin_market_catalog").length} · 页面：${headings.includes("插件市场") ? "插件市场" : "主界面"} · 未预期命令：${unexpected.length}${unexpectedStatus}`;
}

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  calls.push(command);
  switch (command) {
    case "get_setting": return JSON.stringify(settings);
    case "set_setting": return;
    case "feature_catalog":
    case "search_features":
    case "search_local_apps":
    case "list_pending_agent_requests":
    case "list_plugins": return [];
    case "search_plugin_main_push_candidates": {
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && !(rawArgs instanceof ArrayBuffer)
        ? rawArgs as Record<string, unknown> : {};
      if (typeof args.query !== "string" || typeof args.fixedContent !== "boolean"
        || Object.keys(args).some(name => name !== "query" && name !== "fixedContent")) {
        unexpected.push(`${command} (invalid arguments)`);
        updateObservation();
        throw new Error("Unexpected main-push discovery fixture arguments");
      }
      return [];
    }
    case "fetch_plugin_market_catalog": {
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && !(rawArgs instanceof ArrayBuffer)
        ? rawArgs as Record<string, unknown> : {};
      return { ...fixedCatalog, source_url: String(args.url ?? fixedCatalog.source_url) };
    }
    case "get_accessibility_permission_status": return { supported: false, trusted: false };
    case "system_get_path": {
      const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && !(rawArgs instanceof ArrayBuffer)
        ? rawArgs as Record<string, unknown> : {};
      if (args.name !== "home" || Object.keys(args).some(name => name !== "name")) {
        unexpected.push(`${command} (invalid arguments)`);
        updateObservation();
        throw new Error("Unexpected system_get_path fixture arguments");
      }
      return "/fixture/home";
    }
    case "reset_window":
    case "expand_window":
    case "show_main_window":
    case "hide_main_window": return;
    case "plugin:event|listen": return ++nextEventId;
    case "plugin:event|unlisten": return;
    default:
      unexpected.push(command);
      updateObservation();
      throw new Error(`Unexpected market search fixture IPC command: ${command}`);
  }
});

new MutationObserver(updateObservation).observe(appRoot, { subtree: true, childList: true, attributes: true, characterData: true });
mount(App, { target: appRoot, props: { backgroundServices: false } });
flushSync();
void tick().then(updateObservation).catch(error => {
  observation.textContent = `Fixture 启动失败：${String(error)}`;
  throw error;
});
