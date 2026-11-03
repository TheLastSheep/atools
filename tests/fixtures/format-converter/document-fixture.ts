import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { FeatureAction } from "../../../src/lib/types";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../../src/lib/pluginPanelBridgeCompiler";
import type { FormatConverterNodeSession } from "./runtime-fixture";
import type { FormatConverterPackageCopy } from "./original-package";

/** Builds the real plugin document with one fixed files-entry payload and production bridge scripts. */
export function createFormatConverterDocument(options: {
  packageCopy: FormatConverterPackageCopy;
  preloadScript: string;
  session: FormatConverterNodeSession;
  pluginDataRoot: string;
  initialInputPath: string;
  browserWindowId: string;
  webContentsId: number;
}) {
  if (!options.session.endpoints.openDialog) throw new Error("Format Converter UI needs the fixed open-dialog fixture endpoint");
  const dataInstanceId = randomUUID();
  const pathsInstanceId = randomUUID();
  const dialogInstanceId = randomUUID();
  const payload = [{ path: options.initialInputPath, name: basename(options.initialInputPath), isFile: true, isDirectory: false }];
  const action: FeatureAction = {
    plugin_id: "format-converter", plugin_name: "格式转换", feature_code: "format-converter",
    main_url: "index.html", plugin_path: options.packageCopy.pluginRoot,
    expand_height: 0, plugin_permissions: ["data", "dialog"], payload, entry_type: "files",
  };
  const bridge = createPluginBridgeDocument({
    action,
    entryMode: "activate",
    windowType: "browserWindow",
    windowHostKind: "hosted",
    browserWindowId: options.browserWindowId,
    geometrySnapshot: null,
    workerScope: "format-converter-original-browser-fixture",
    mainPushConfig: null,
    webContentsId: options.webContentsId,
    subInputEpoch: 0,
    appName: "ATools Format Converter browser fixture",
    appVersion: "3.0.0",
    data: { instanceId: dataInstanceId, endpoint: options.session.endpoints.data, usage: "detected" },
    paths: { instanceId: pathsInstanceId, paths: { userData: options.pluginDataRoot, pluginData: options.pluginDataRoot } },
    dialogs: { instanceId: dialogInstanceId,
      endpoints: { open: options.session.endpoints.openDialog, save: options.session.endpoints.saveDialog } },
  });
  return {
    html: injectPluginBridgeHtml(options.packageCopy.indexHtml, `${bridge}${options.preloadScript}`),
    dataInstanceId, pathsInstanceId, dialogInstanceId, featureAction: action,
  };
}
