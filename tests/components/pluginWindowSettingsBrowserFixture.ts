import "../../src/styles/global.css";
import { mount, unmount, tick, type ComponentProps } from "svelte";
import PluginPanelChrome from "../../src/components/PluginPanelChrome.svelte";

const target = document.getElementById("chrome");
if (!target) throw new Error("Missing fixture chrome target");
const preferences = new Map<string, boolean>();
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let failSave = false;
let failLoad = false;
let component: ReturnType<typeof mount> | undefined;

async function invoke(command: string, args: Record<string, unknown>) {
  calls.push({ command, args: { ...args } });
  if (command === "get_plugin_window_preferences") {
    if (failLoad) { failLoad = false; throw new Error("夹具：读取失败，可重试或重置"); }
    return { autoDetach: preferences.get(String(args.pluginId)) ?? false };
  }
  if (command === "set_plugin_auto_detach") {
    if (failSave) { failSave = false; throw new Error("夹具：保存失败，请重试"); }
    if (typeof args.enabled !== "boolean") throw new Error("Invalid fixture preference");
    preferences.set(String(args.pluginId), args.enabled);
    return { autoDetach: args.enabled };
  }
  throw new Error(`Unexpected fixture command: ${command}`);
}

Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

async function show(pluginId: string, title: string) {
  if (component) await unmount(component);
  const props: ComponentProps<typeof PluginPanelChrome> = {
    visible: true, title, feature: "固定验收入口",
    actions: [{ id: "settings", label: "设置", available: false }, { id: "detach", label: "分离", available: true }],
    inputVisible: false, value: "", placeholder: "输入关键词",
    onInput: () => {}, onReturn: () => {}, onEscape: () => {},
    onMove: () => false, onBoundary: () => false, onActivate: () => false, onAction: () => {},
    showDiagnostics: false, diagnosticsChips: [], diagnosticIdentity: { featureCode: "open", source: pluginId },
    displayStatus: null, fileDropStatus: null, hostClipboardStatus: null,
    dialogsStatus: null, pathsStatus: null, dataStatus: null, reopening: false,
    onReopenData: () => {}, onReopenClipboard: () => {}, onReopenPaths: () => {},
  };
  component = mount(PluginPanelChrome, { target: target!, props });
  await tick();
}

document.getElementById("plugin-a")!.onclick = () => { void show("harris.live-markdown", "Live Markdown"); };
document.getElementById("plugin-b")!.onclick = () => { void show("harris.paste", "Paste"); };
document.getElementById("fail-save")!.onclick = () => { failSave = true; };
document.getElementById("fail-load")!.onclick = () => { failLoad = true; };
document.getElementById("theme")!.onclick = () => {
  document.documentElement.dataset.atoolsTheme = document.documentElement.dataset.atoolsTheme === "dark" ? "light" : "dark";
};
Object.assign(window, { atoolsWindowSettingsFixture: { calls, preferences } });
void show("harris.live-markdown", "Live Markdown");
