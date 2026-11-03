import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../../src/lib/pluginPanelBridgeCompiler";

export type LiveMarkdownNodeEndpoints = { node: string; data: string; saveDialog: string; openDialog?: string };

export type LiveMarkdownEntryRoute = "files" | "menu-open";

export function createLiveMarkdownDocument(options: {
  route: LiveMarkdownEntryRoute;
  pluginRoot: string;
  indexHtml: string;
  preloadScript: string;
  endpoints: LiveMarkdownNodeEndpoints;
  pluginDataPath: string;
  documentPath: string;
  browserWindowId: string;
  webContentsId: number;
}) {
  if (options.route === "menu-open" && !options.endpoints.openDialog) {
    throw new Error("The original menu-open route requires a controlled open-dialog endpoint");
  }
  const dataInstanceId = randomUUID();
  const dialogInstanceId = randomUUID();
  const bridge = createPluginBridgeDocument({
    action: {
      plugin_id: "live-markdown", plugin_name: "Live Markdown", feature_code: "typora-workbench",
      main_url: "index.html", plugin_path: options.pluginRoot, expand_height: 0,
      plugin_permissions: ["data", "dialog"],
      entry_type: options.route === "menu-open" ? "text" : "files",
      payload: options.route === "menu-open" ? null : [{ path: options.documentPath, name: basename(options.documentPath), isFile: true, isDirectory: false }],
    },
    entryMode: "activate", windowType: "browserWindow", windowHostKind: "hosted",
    browserWindowId: options.browserWindowId, geometrySnapshot: null,
    workerScope: "live-markdown-original-browser-fixture", mainPushConfig: null,
    webContentsId: options.webContentsId, subInputEpoch: 0,
    appName: "ATools Live Markdown browser fixture", appVersion: "3.0.0",
    data: { instanceId: dataInstanceId, endpoint: options.endpoints.data, usage: "detected" },
    paths: { instanceId: dataInstanceId, paths: { pluginData: options.pluginDataPath } },
    dialogs: { instanceId: dialogInstanceId, endpoints: { save: options.endpoints.saveDialog,
      ...(options.endpoints.openDialog ? { open: options.endpoints.openDialog } : {}) } },
  });
  const html = injectPluginBridgeHtml(options.indexHtml,
    `${liveMarkdownWindowMetadataObserverScript()}${bridge}${options.preloadScript}`);
  return { html, dataInstanceId, dialogInstanceId };
}

function liveMarkdownWindowMetadataObserverScript() {
  return `<script data-atools-live-markdown-fixture-metadata>(function(){
window.__atoolsLiveMarkdownFixture={windowMetadata:[],rejectedIpc:[]};
window.addEventListener('message',function(event){
  if(event.source!==window||!event.data||typeof event.data!=='object')return;
  var message=event.data,keys=Object.keys(message).sort();
  if(!keys.some(function(key){return key.indexOf('__ipc_')===0;}))return;
  var accepted=keys.length===2&&message.__ipc_plugin_height__===true&&message.height===820;
  var record={keys:keys,height:message.height,accepted:accepted};
  if(accepted)window.__atoolsLiveMarkdownFixture.windowMetadata.push(record);
  else window.__atoolsLiveMarkdownFixture.rejectedIpc.push(record);
});
})();</script>`;
}
