import "../../src/styles/global.css";
import { flushSync, mount as mountComponent, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
import type { InstalledPlugin } from "../../src/lib/types";

type IpcCall = { command: string; args: Record<string, unknown> | null };
type FixtureApi = {
  calls: IpcCall[];
  focusoutObservations: Array<{ originPluginId: string | null; originConnected: boolean; relatedTarget: string | null }>;
  mount(count: number): Promise<void>;
  failNextList(): void;
  dispose(): Promise<void>;
  get unexpectedCommands(): string[];
};

const calls: IpcCall[] = [];
const focusoutObservations: FixtureApi["focusoutObservations"] = [];
const unexpectedCommands: string[] = [];
let installed: InstalledPlugin[] = [];
let app: ReturnType<typeof mountComponent> | undefined;
let listFailures = 0;

function plugin(index: number): InstalledPlugin {
  const id = `keyboard-${String(index).padStart(2, "0")}`;
  const name = `插件 ${String(index).padStart(2, "0")}`;
  return {
    id, name, version: "1.0.0", enabled: true, source_kind: "imported", path: `/fixture/installed/${id}`,
    created_at: "2026-10-19", updated_at: "2026-10-19",
    manifest: { title: name, description: "离线键盘导航夹具", main: "index.html", features: [
      { code: `${id}-open`, label: "打开", explain: "打开此插件" },
    ] },
  };
}

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  calls.push({ command, args });
  if (command === "plugin:event|listen") return 1;
  if (command === "plugin:event|unlisten") return;
  if (command === "list_plugins") {
    if (listFailures > 0) { listFailures -= 1; throw new Error("fixture-list-read-failed"); }
    return structuredClone(installed);
  }
  unexpectedCommands.push(command);
  throw new Error(`Keyboard browser fixture rejected unexpected IPC: ${command}`);
});

async function mount(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 61) throw new Error("Fixture count must be between 1 and 61");
  if (app) await unmount(app);
  app = undefined;
  calls.length = 0;
  focusoutObservations.length = 0;
  listFailures = 0;
  unexpectedCommands.length = 0;
  installed = Array.from({ length: count }, (_, index) => plugin(index + 1));
  const target = document.getElementById("app");
  if (!target) throw new Error("Missing real component mount target");
  app = mountComponent(PluginInventoryPanel, { target, props: { confirm: async () => true } });
  flushSync();
  await tick();
  const list = target.querySelector<HTMLElement>(".plugin-list");
  list?.addEventListener("focusout", event => {
    const focus = event as FocusEvent;
    const origin = focus.target instanceof HTMLElement ? focus.target.closest<HTMLElement>("[data-plugin-detail-id]") : null;
    if (!origin) return;
    const related = focus.relatedTarget instanceof HTMLElement
      ? `${focus.relatedTarget.tagName.toLowerCase()}${focus.relatedTarget.getAttribute("aria-label") ? `:${focus.relatedTarget.getAttribute("aria-label")}` : ""}`
      : focus.relatedTarget === null ? null : "non-element";
    focusoutObservations.push({ originPluginId: origin.dataset.pluginDetailId ?? null,
      originConnected: origin.isConnected, relatedTarget: related });
  });
}

async function dispose() {
  if (app) await unmount(app);
  app = undefined;
}

function failNextList() { listFailures += 1; }

const api: FixtureApi = {
  calls,
  focusoutObservations,
  mount,
  failNextList,
  dispose,
  get unexpectedCommands() { return [...unexpectedCommands]; },
};
Object.assign(window, { pluginInventoryKeyboardFixture: api, pluginInventoryKeyboardFixtureReady: true });
