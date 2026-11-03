import type { HostClipboardConfig } from "./hostClipboardBridge";
import type { PluginDialogsConfig } from "./pluginNativeDialogBridge";
import type { PluginPathsConfig } from "./pluginPathsBridge";
import type { PluginDataConfig } from "./pluginDataBridge";
import type { PluginDisplayConfig } from "./pluginDisplayBridge";

type Transfer<T> = { reopen: () => Promise<T> };
/** Transfer all active approvals together; partial or stale successors must be drained. */
export async function reopenPluginHost(options: {
  clipboard: Transfer<HostClipboardConfig>; data?: Transfer<PluginDataConfig>; paths?: Transfer<PluginPathsConfig>; dialogs?: Transfer<PluginDialogsConfig>;
  display?: Transfer<PluginDisplayConfig>;
  current: () => boolean;
  pluginId: string;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const pluginId = options.pluginId, invoke = options.invoke;
  const closeSuccessor = (kind: "clipboard" | "data" | "paths" | "dialogs" | "display", instanceId: string) => invoke(
    kind === "display" ? "close_plugin_display" : kind === "dialogs" ? "close_plugin_dialogs" : kind === "data" ? "close_plugin_data" : kind === "paths" ? "close_plugin_paths" : "close_host_clipboard", { pluginId, instanceId });
  const [clipboard, data, paths, dialogs, display] = await Promise.allSettled([
    options.clipboard.reopen(), options.data?.reopen() ?? Promise.resolve(undefined), options.paths?.reopen() ?? Promise.resolve(undefined), options.dialogs?.reopen() ?? Promise.resolve(undefined),
    options.display?.reopen() ?? Promise.resolve(undefined),
  ]);
  if (clipboard.status === "fulfilled" && data.status === "fulfilled" && paths.status === "fulfilled" && dialogs.status === "fulfilled" && display.status === "fulfilled" && options.current()) {
    return { clipboard: clipboard.value, data: data.value, paths: paths.value, dialogs: dialogs.value, ...(options.display ? { display: display.value } : {}) };
  }
  await Promise.allSettled([
    clipboard.status === "fulfilled" ? closeSuccessor("clipboard", clipboard.value.instanceId) : Promise.resolve(),
    data.status === "fulfilled" && data.value ? closeSuccessor("data", data.value.instanceId) : Promise.resolve(),
    paths.status === "fulfilled" && paths.value ? closeSuccessor("paths", paths.value.instanceId) : Promise.resolve(),
    dialogs.status === "fulfilled" && dialogs.value ? closeSuccessor("dialogs", dialogs.value.instanceId) : Promise.resolve(),
    display.status === "fulfilled" && display.value ? closeSuccessor("display", display.value.instanceId) : Promise.resolve(),
  ]);
  throw new Error("Plugin reopen was cancelled or could not transfer its approvals");
}
