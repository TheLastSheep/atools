import type { FeatureAction } from "./types";
import type { createPluginPanelDocumentHost } from "./pluginPanelDocumentHost";
import type { createHostClipboardController, HostClipboardStatus } from "./hostClipboardController";
import type { HostClipboardConfig } from "./hostClipboardBridge";
import type { createPluginDisplayController } from "./pluginDisplayController";
import type { PluginDisplayConfig } from "./pluginDisplayBridge";
import type { createPluginDataController } from "./pluginDataController";
import type { PluginDataConfig } from "./pluginDataBridge";
import type { createPluginDialogsController } from "./pluginDialogsController";
import type { PluginDialogsConfig } from "./pluginNativeDialogBridge";
import type { createPluginPathsController } from "./pluginPathsController";
import type { PluginPathsConfig } from "./pluginPathsBridge";
import { reopenPluginHost } from "./pluginHostReopen";

type Ports = {
  action: () => FeatureAction;
  page: () => ReturnType<typeof createPluginPanelDocumentHost> | undefined;
  clipboard: () => ReturnType<typeof createHostClipboardController> | undefined;
  data: () => ReturnType<typeof createPluginDataController> | undefined;
  paths: () => ReturnType<typeof createPluginPathsController> | undefined;
  dialogs: () => ReturnType<typeof createPluginDialogsController> | undefined;
  display: () => ReturnType<typeof createPluginDisplayController> | undefined;
  generation: () => number;
  loadError: () => string | null;
  isBusy: () => boolean;
  setBusy: (value: boolean) => void;
  setClipboardStatus: (value: HostClipboardStatus) => void;
  pathsStatus: () => { state: "pending" | "ready" | "error"; message: string } | null;
  loadPluginHtml: (clipboard?: HostClipboardConfig, data?: PluginDataConfig, paths?: PluginPathsConfig, dialogs?: PluginDialogsConfig, display?: PluginDisplayConfig) => Promise<void>;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/** Owns the panel's existing whole-host approval transfer and recovery actions. */
export function createPluginPanelCapabilityReopen(ports: Ports) {
  async function reopenClipboard() {
    if (ports.page()) { await ports.loadPluginHtml(); return; }
    const clipboard = ports.clipboard();
    const data = ports.data();
    const paths = ports.paths();
    const dialogs = ports.dialogs();
    const display = ports.display();
    const pluginId = ports.action().plugin_id;
    const generation = ports.generation();
    if (!clipboard || ports.isBusy()) return;
    ports.setBusy(true);
    try {
      const next = await reopenPluginHost({
        clipboard, data, paths, dialogs, display, pluginId, invoke: ports.invoke,
        current: () => generation === ports.generation() && ports.clipboard() === clipboard
          && ports.data() === data && ports.paths() === paths && ports.dialogs() === dialogs && ports.display() === display,
      });
      await ports.loadPluginHtml(next.clipboard, next.data, next.paths, next.dialogs, next.display);
    } catch {
      if (ports.clipboard() === clipboard) ports.setClipboardStatus({ state: "error", access: "read", message: "重新打开未完成，请退出插件后再试" });
    } finally {
      ports.setBusy(false);
    }
  }

  async function reopenData() {
    if (ports.isBusy()) return;
    if (ports.loadError()) { await ports.loadPluginHtml(); return; }
    await reopenClipboard();
  }

  async function reopenPaths() {
    if (ports.pathsStatus()?.state === "ready") { await reopenClipboard(); return; }
    await reopenData();
  }

  return { reopenClipboard, reopenData, reopenPaths };
}
