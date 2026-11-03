import { randomUUID } from "node:crypto";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../../src/lib/pluginPanelBridgeCompiler";
import type { PasteStartupEndpoints } from "./worker-lifecycle";

type PasteStartupDocumentOptions = {
  pluginRoot: string;
  indexHtml: string;
  preloadScript: string;
  endpoints: PasteStartupEndpoints;
  pluginDataPath: string;
  instanceId?: string;
  secretStorageInstanceId?: string;
  windowType?: "main" | "browserWindow";
  browserWindowId?: string;
  webContentsId?: number;
  appName?: string;
  beforeBridgeScript?: string;
};

/** Builds the production bridge document independently of any DOM implementation. */
export function createPasteStartupDocument(options: PasteStartupDocumentOptions) {
  const instanceId = options.instanceId ?? randomUUID();
  const secretStorageInstanceId = options.secretStorageInstanceId ?? randomUUID();
  const windowType = options.windowType ?? "main";
  const bridge = createPluginBridgeDocument({
    action: {
      plugin_id: "pasteboard-pro", plugin_name: "Paste剪切板", feature_code: "pasteboard-pro",
      main_url: "index.html", plugin_path: options.pluginRoot, expand_height: 0, payload: null,
      // Fixture grant reaches only the host bridge; keyboard monitoring remains a controlled pipe port.
      plugin_permissions: ["clipboard.read", "clipboard.write", "input.keyboard"],
    },
    entryMode: "preload", windowType, windowHostKind: windowType === "browserWindow" ? "hosted" : undefined,
    browserWindowId: options.browserWindowId ?? "", geometrySnapshot: null,
    workerScope: "pasteboard-pro-startup-fixture", mainPushConfig: null,
    webContentsId: options.webContentsId ?? 1301, subInputEpoch: 0,
    appName: options.appName ?? "ATools Paste startup fixture", appVersion: "3.0.0",
    clipboard: { instanceId, endpoints: {
      history_read: options.endpoints.history, write: options.endpoints.write, content_write: options.endpoints.contentWrite,
    } },
    data: { instanceId, endpoint: options.endpoints.data, usage: "detected" },
    paths: { instanceId, paths: { pluginData: options.pluginDataPath } },
    secretStorage: { instanceId: secretStorageInstanceId, endpoint: options.endpoints.secret, available: true },
  });
  return {
    html: injectPluginBridgeHtml(options.indexHtml, `${options.beforeBridgeScript ?? ""}${bridge}${options.preloadScript}`),
    instanceId,
    secretStorageInstanceId,
  };
}
