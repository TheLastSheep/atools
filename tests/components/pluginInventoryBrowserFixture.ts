import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InstalledPlugin } from "../../src/lib/types";

const settings = { localAppSearch: false, localLaunchSearch: false, autoPaste: "never", autoBackToSearch: "never", pluginMarketCustom: false };
type IpcCall = { command: string; args: Record<string, unknown> | null; pendingKey?: string };
const calls: IpcCall[] = [], unexpectedCommands: string[] = [];
const listeners = new Map<number, { event: string; handler: number }>();
const pending = new Map<string, (value: unknown) => void>();
const plans = new Map<string, string[]>();
let sequence = 0, failList = false, failAfterMutation = false;
let app: ReturnType<typeof mount> | undefined;
let installed: InstalledPlugin[] = [];
function plugin(id: string, title: string, enabled = true): InstalledPlugin {
  const features = id === "multi-tools" ? [
    { code: `${id}-first`, label: "文本整理", explain: "整理文本格式" },
    { code: `${id}-second`, label: "本地 JSON 批量压缩", explain: "压缩本地 JSON 文本并保留缩进规则" },
    { code: `${id}-long-target`, label: "用于验证窄视口仍完整保留无障碍名称的超长插件功能标题", explain: "长名称布局验证" },
    { code: `${id}-shared-one`, label: "共同筛选项一", explain: "" },
    { code: `${id}-shared-two`, label: "共同筛选项二", explain: "" },
  ] : [
    { code: `${id}-first`, label: "文本整理", explain: "整理文本格式" },
    { code: `${id}-second`, label: "JSON 压缩", explain: "压缩 JSON 文本" },
  ];
  return { id, source_kind: "imported", name: id, version: "1.0.0", enabled, path: `/fixture/installed/${id}`, created_at: "2026-10-16", updated_at: "2026-10-16",
    manifest: { title, description: "离线使用的本地工具", main: "index.html", permissions: ["data"], features: [
      ...features,
    ] } };
}
function catalogue() {
  const ordinary = plugin("multi-tools", "文本工具集");
  const disabled = plugin("offline-notes", "离线笔记", false);
  const builtin = { ...plugin("builtin-json", "内置 JSON", false), source_kind: "builtin" as const };
  const rest = Array.from({ length: 1197 }, (_, index) => plugin(`catalogue-${String(index).padStart(4, "0")}`, `工具 ${String(index).padStart(4, "0")}`, index % 3 !== 0));
  return [ordinary, disabled, builtin, ...rest];
}
function nextKey(command: string) { const queue = plans.get(command); return queue?.shift(); }
function mutation() { if (failAfterMutation) { failAfterMutation = false; failList = true; } }
mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  if (command === "plugin:event|listen") { const id = ++sequence; listeners.set(id, { event: String(args?.event), handler: Number(args?.handler) }); return id; }
  if (command === "plugin:event|unlisten") { listeners.delete(Number(args?.eventId)); return; }
  const pendingKey = nextKey(command);
  calls.push({ command, args, pendingKey });
  if (pendingKey) return new Promise(resolve => pending.set(pendingKey, resolve));
  switch (command) {
    case "get_setting": return JSON.stringify(settings);
    case "set_setting": return;
    case "get_accessibility_permission_status": return { supported: false, trusted: false };
    case "get_home_dir": case "system_get_path": return "/fixture/home";
    case "feature_catalog": case "search_features": case "search_local_apps": case "list_pending_agent_requests": return [];
    case "list_plugins": if (failList) { failList = false; throw new Error("模拟：清单暂时不可读取"); } return structuredClone(installed);
    case "plugin:dialog|open": return null;
    case "toggle_plugin": {
      const record = installed.find(item => item.id === args?.pluginId);
      if (!record || typeof args?.enabled !== "boolean") throw new Error("Invalid toggle fixture args");
      record.enabled = args.enabled; mutation(); return;
    }
    case "authorize_plugin_permissions": {
      const record = installed.find(item => item.id === args?.pluginId);
      if (!record || record.enabled) throw new Error("Invalid authorize fixture args");
      record.enabled = true; mutation(); return structuredClone(record);
    }
    case "uninstall_plugin": installed = installed.filter(item => item.id !== args?.pluginId); mutation(); return;
    case "install_plugin": { const record = plugin("new-plugin", "新安装的插件", false); installed.push(record); mutation(); return structuredClone(record); }
    case "update_plugin_from_path": {
      const record = installed.find(item => item.id === args?.pluginId);
      if (!record) throw new Error("Unknown update fixture ID");
      record.version = "2.0.0"; mutation(); return structuredClone(record);
    }
    case "activate_feature": throw new Error("Synthetic activation failure; plugin business is not executed by this fixture");
    case "call_agent_tool":
      if (args?.name !== "open_or_reveal_path" || args?.clientId !== "atools-ui" || args?.confirmed !== true) throw new Error("Unexpected human capability");
      return { content: [{ type: "text", text: "fixture reveal" }], isError: false };
    case "expand_window": case "reset_window": case "show_main_window": case "hide_main_window":
    case "set_floating_ball_visible": case "set_super_panel_visible": return null;
    default: unexpectedCommands.push(command); throw new Error(`Inventory fixture did not authorize IPC: ${command}`);
  }
});
async function mountFresh() {
  if (app) await unmount(app);
  calls.length = 0; unexpectedCommands.length = 0; pending.clear(); plans.clear();
  installed = catalogue(); failList = false; failAfterMutation = false;
  localStorage.clear(); localStorage.setItem("atools-settings", JSON.stringify(settings));
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync(); await tick();
}
async function dispose() { if (app) await unmount(app); app = undefined; }
const fixture = { calls, unexpectedCommands, listeners, mountFresh, dispose,
  plan(command: string, key: string) { plans.set(command, [...plans.get(command) ?? [], key]); },
  resolve(key: string, value: unknown) { const resolve = pending.get(key); if (!resolve) throw new Error(`No pending fixture ${key}`); pending.delete(key); resolve(value); },
  failReadAfterMutation() { failAfterMutation = true; },
  get installed() { return structuredClone(installed); },
};
Object.assign(window, { pluginInventoryFixture: fixture });
void mountFresh();
