import type { FeatureAction } from "./types";
import type { PluginContextMenuInfo } from "./pluginPanelContracts";
import type { PluginBrowserWindowParentMessage } from "./pluginBrowserWindowTypes";
import { pluginFeatureIcon } from "./pluginFeatureIcons";
import { pluginResourceFilePath } from "./pluginResourceHtml";

export function pluginContextMenuTarget(info: PluginContextMenuInfo | null): string {
  if (!info) return "";
  if (info.editable) return "可编辑区域";
  return info.tagName ? `iframe ${info.tagName.toLowerCase()}` : "iframe";
}

export function pluginBrowserWindowMessageLabel(message: PluginBrowserWindowParentMessage | null): string {
  if (!message) return "";
  return message.args.length > 0 ? `${message.channel} +${message.args.length}` : message.channel;
}

export function createPluginFeatureIconResolver(
  action: () => FeatureAction,
  resolveModuleSrc: (path: string) => string | Promise<string> | undefined,
) {
  return (value: string) => pluginFeatureIcon(value, async relative => {
    const current = action();
    const path = pluginResourceFilePath(current.plugin_path, current.main_url || "index.html", relative);
    return path ? await resolveModuleSrc(path) ?? "" : "";
  });
}
