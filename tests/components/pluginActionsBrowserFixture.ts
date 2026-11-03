import "../../src/styles/global.css";
import { flushSync, mount, tick, unmount } from "svelte";
import PluginActionsBrowserHarness from "./PluginActionsBrowserHarness.svelte";

type ActionId = "settings" | "detach";
type CallbackRecord = { type: "return" | "input" | "action" | "runtime-info" | "body" | "iframe-body"; value?: string; actionId?: ActionId };
type FixtureApi = {
  route: string;
  callbacks: CallbackRecord[];
  setSettingsAvailable(available: boolean): Promise<void>;
  getState(): { settingsAvailable: boolean; inputValue: string; runtimeExpanded: boolean; callbacks: CallbackRecord[] };
  dispose(): Promise<void>;
};

const root = document.querySelector<HTMLElement>("#navigation");
const bodyAction = document.querySelector<HTMLButtonElement>("#fixture-body-action");
const runtimePanel = document.querySelector<HTMLElement>("#fixture-runtime-info");
const pluginFrame = document.querySelector<HTMLIFrameElement>("#fixture-plugin-frame");
if (!root || !bodyAction || !runtimePanel || !pluginFrame) throw new Error("Plugin actions browser fixture roots are missing");

const route = new URL(window.location.href).searchParams.get("route") ?? "baseline";
if (route !== "baseline" && route !== "menu") throw new Error(`Unsupported browser fixture route: ${route}`);

const callbacks: CallbackRecord[] = [];
let component: ReturnType<typeof mount> | undefined;
let settingsAvailable = false;
let inputValue = "";
let runtimeExpanded = false;

function record(callback: CallbackRecord) {
  callbacks.push(callback);
  if (callback.type === "input") inputValue = callback.value ?? "";
  if (callback.type === "runtime-info") runtimeExpanded = !runtimeExpanded;
}

function handleFrameMessage(event: MessageEvent) {
  if (event.source !== pluginFrame.contentWindow || event.data !== "fixture-plugin-body-action") return;
  record({ type: "iframe-body" });
}

component = mount(PluginActionsBrowserHarness, { target: root, props: { onCallback: record } });
flushSync();
pluginFrame.srcdoc = `<!doctype html><html lang="zh-CN"><body style="margin:12px;font:13px sans-serif">
  <button id="fixture-iframe-action" type="button" onclick="parent.postMessage('fixture-plugin-body-action', parent.location.origin)">iframe 内操作插件正文</button>
</body></html>`;
bodyAction.addEventListener("click", () => record({ type: "body" }));
window.addEventListener("message", handleFrameMessage);

const api: FixtureApi = {
  route,
  callbacks,
  async setSettingsAvailable(available) {
    settingsAvailable = available;
    window.dispatchEvent(new CustomEvent("fixture:set-settings", { detail: available }));
    await tick();
  },
  getState() {
    return {
      settingsAvailable,
      inputValue,
      runtimeExpanded,
      callbacks: callbacks.map(item => ({ ...item })),
    };
  },
  async dispose() {
    window.removeEventListener("message", handleFrameMessage);
    if (component) await unmount(component);
    component = undefined;
    callbacks.length = 0;
  },
};

Object.assign(window, { pluginActionsBrowserFixture: api });
runtimePanel.hidden = true;
