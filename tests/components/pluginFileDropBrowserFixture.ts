import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../src/lib/pluginPanelBridgeCompiler";
import { createPluginPanelFileDropHost } from "../../src/lib/pluginPanelFileDropHost";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import type { TaskRun } from "../../src/lib/types";

const pluginId = "fixture.file-drop.browser";
const marker = "__atools_file_drop_browser_fixture__";
const ids = [
  { intent: "81000000-0000-4000-8000-000000000001", request: "82000000-0000-4000-8000-000000000001", run: "83000000-0000-4000-8000-000000000001", lease: "84000000-0000-4000-8000-000000000001" },
  { intent: "81000000-0000-4000-8000-000000000002", request: "82000000-0000-4000-8000-000000000002", run: "83000000-0000-4000-8000-000000000002", lease: "84000000-0000-4000-8000-000000000002" },
  { intent: "81000000-0000-4000-8000-000000000003", request: "82000000-0000-4000-8000-000000000003", run: "83000000-0000-4000-8000-000000000003", lease: "84000000-0000-4000-8000-000000000003" },
];
const rows = [
  { name: "fixture-alpha.txt", path: "/fixture/approved/alpha.txt", type: "text/plain", lastModified: 1_700_000_001, content: "alpha" },
  { name: "fixture-beta.bin", path: "/fixture/approved/beta.bin", type: "application/octet-stream", lastModified: 1_700_000_002, content: "beta!" },
];

type NativeDrop = { intentId: string; xPhysical: number; yPhysical: number; scaleFactor: number; fileCount: number };
type NativeHandler = (event: { payload: unknown }) => void;

function encodePacket(requestId: string, leaseId: string, expiresAt: number): ArrayBuffer {
  const chunks = rows.map(row => new TextEncoder().encode(row.content));
  let offset = 0;
  const files = rows.map((row, index) => {
    const file = { name: row.name, path: row.path, type: row.type, lastModified: row.lastModified,
      size: chunks[index].byteLength, offset };
    offset += chunks[index].byteLength;
    return file;
  });
  const header = new TextEncoder().encode(JSON.stringify({ requestId, leaseId, expiresAt, files }));
  const packet = new ArrayBuffer(9 + header.byteLength + offset);
  const bytes = new Uint8Array(packet), view = new DataView(packet);
  bytes.set([65, 84, 70, 68, 1]);
  view.setUint32(5, header.byteLength, true);
  bytes.set(header, 9);
  let cursor = 9 + header.byteLength;
  for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
  return packet;
}

function frameHtml(webContentsId: number) {
  const preload = `<script>(function(){var listeners={};var ipc={on:function(){return ipc},addListener:function(){return ipc},once:function(){return ipc},off:function(){return ipc},removeListener:function(){return ipc},removeAllListeners:function(){return ipc}};window.require=function(name){if(name!=="electron")throw new Error("Fixture only supplies Electron's documented IPC shape");return{ipcRenderer:ipc};};})();</script>`;
  const action = { plugin_id: pluginId, plugin_name: "Synthetic file drop", feature_code: "drop", main_url: "about:blank",
    plugin_path: "/fixture/plugin", expand_height: 480, payload: null, entry_type: "files" as const };
  const bridge = createPluginBridgeDocument({ action, windowType: "main", browserWindowId: "", geometrySnapshot: null,
    workerScope: "fixture-file-drop", mainPushConfig: null, webContentsId, subInputEpoch: 0, appName: "ATools QA", appVersion: "0" });
  const probe = `<script>(function(){
    var target=document.getElementById("drop-target"),dragTypes=[],dragSamples=[],firstTransfer=null,firstNativeFiles=[],lastFile=null,results=[];
    function pathCall(fn,file){try{return{ok:true,path:fn(file)}}catch(error){return{ok:false,code:error&&error.message||String(error)}}}
    function readPaths(file){var electron=window.require("electron");return{
      ztools1:pathCall(function(value){return window.ztools.getPathForFile(value)},file),
      ztools2:pathCall(function(value){return window.ztools.getPathForFile(value)},file),
      electron1:pathCall(function(value){return electron.webUtils.getPathForFile(value)},file),
      electron2:pathCall(function(value){return electron.webUtils.getPathForFile(value)},file)
    }}
    ["dragenter","dragover","drop"].forEach(function(type){target.addEventListener(type,function(event){
      if(type==="dragenter"){dragTypes=[];dragSamples=[];firstTransfer=null;firstNativeFiles=[]}
      if(!firstTransfer){firstTransfer=event.dataTransfer;firstNativeFiles=Array.prototype.slice.call(event.dataTransfer.files)}
      dragTypes.push(type);dragSamples.push({type:type,isTrusted:event.isTrusted,dragEventRealm:event instanceof DragEvent,
        dataTransferRealm:event.dataTransfer instanceof DataTransfer,sameTransfer:event.dataTransfer===firstTransfer,
        sameFile:event.dataTransfer.files[0]===firstNativeFiles[0],
        sameFiles:event.dataTransfer.files.length===firstNativeFiles.length&&Array.prototype.every.call(event.dataTransfer.files,function(file,index){return file===firstNativeFiles[index]})});if(type==="drop"){
        lastFile=event.dataTransfer.files[0];var clone=new File([lastFile],lastFile.name,{type:lastFile.type,lastModified:lastFile.lastModified});
        var files=Array.prototype.slice.call(event.dataTransfer.files);
        Promise.all(files.map(function(file){return file.arrayBuffer().then(function(buffer){return{name:file.name,type:file.type,lastModified:file.lastModified,
          fileRealm:file instanceof File,bytes:Array.prototype.slice.call(new Uint8Array(buffer)),paths:readPaths(file)}})})).then(function(fileDetails){
          var result={kind:"drop",types:dragTypes.slice(),dragSamples:dragSamples.slice(),isTrusted:event.isTrusted,fileName:lastFile.name,
            fileRealm:lastFile instanceof File,dataTransferRealm:event.dataTransfer instanceof DataTransfer,dragEventRealm:event instanceof DragEvent,
            sameFileAcrossEvents:dragSamples.every(function(sample){return sample.sameFiles}),files:fileDetails,
            paths:readPaths(lastFile),clone:readPaths(clone),newFile:readPaths(new File(["alpha"],lastFile.name)),
            spoof:readPaths({name:lastFile.name,path:"/fixture/approved/alpha.txt"})};
          results.push(result);parent.postMessage({${JSON.stringify(marker)}:true,kind:"drop",result:result},"*");
        }).catch(function(error){parent.postMessage({${JSON.stringify(marker)}:true,kind:"drop",result:{error:String(error)}},"*")});
      }
    },true)});
    function query(kind,extra){var result=Object.assign({kind:kind,paths:lastFile?readPaths(lastFile):null},extra||{});results.push(result);parent.postMessage({${JSON.stringify(marker)}:true,kind:kind,result:result},"*")}
    window.addEventListener("message",function(event){if(event.source!==parent||!event.data)return;
      if(event.data[${JSON.stringify(marker)}]==="synthetic-pagehide"){window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:false}));return}
      if(event.data[${JSON.stringify(marker)}]==="query")query(event.data.kind||"query")});
    window.addEventListener("pagehide",function(event){if(!event.isTrusted)query("synthetic-pagehide-event",{eventType:event.type,isTrusted:event.isTrusted,pageTransitionEvent:event instanceof PageTransitionEvent})});
    window.__fileDropFrameProbe={get results(){return results.slice()}};
  })();</script>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#drop-target{margin:0;width:100%;height:100%;overflow:hidden}#drop-target{background:#fff}</style></head><body><div id="drop-target" aria-label="Synthetic drop target"></div>${probe}</body></html>`;
  return injectPluginBridgeHtml(html, preload + bridge);
}

function taskRun(id: string, requestId: string, tool: string): TaskRun {
  return { id, capabilityId: tool, initiator: { type: "human", clientId: "atools-ui" }, status: "succeeded",
    input: { operation: "read", requestId }, output: { requestId, readCompleted: true, runtime: "plugin-file-drop",
      fileCount: rows.length, totalBytes: rows.reduce((total, row) => total + new TextEncoder().encode(row.content).byteLength, 0) },
    artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: null, validation: { status: "not_run" } } as TaskRun;
}

function createNativeDouble(capability: string) {
  const listeners = new Map<string, NativeHandler>();
  const delivered: ArrayBuffer[] = [];
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const runs = new Map<string, TaskRun>();
  const closedInstances: string[] = [];
  const closeWaiters = new Set<(count: number) => void>();
  let deliveryIndex = 0;
  return {
    listeners, delivered, calls, capability, closedInstances, closeWaiters,
    async listen(name: string, handler: NativeHandler) { listeners.set(name, handler); return () => { listeners.delete(name); }; },
    async invoke<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
      if (calls.length >= 32) throw new Error("Native fixture command budget exceeded");
      calls.push({ method, args });
      if (method === "prepare_plugin_file_drop") {
        const entry = ids[deliveryIndex];
        if (!entry) throw new Error("Native fixture delivery budget exceeded");
        runs.set(entry.run, taskRun(entry.run, entry.request, capability));
        return { requestId: entry.request, runId: entry.run, tool: capability, readCompleted: true,
          fileCount: rows.length, totalBytes: 10, runtime: "plugin-file-drop" } as T;
      }
      if (method === "get_task_run") return (runs.get(String(args.id)) ?? null) as T;
      if (method === "get_plugin_file_drop_delivery") {
        const entry = ids[deliveryIndex];
        if (!entry) throw new Error("Native fixture delivery budget exceeded");
        const ttl = deliveryIndex === 1 ? 1_200 : 30_000;
        const packet = encodePacket(entry.request, entry.lease, Date.now() + ttl);
        delivered.push(packet); deliveryIndex++;
        return packet as T;
      }
      if (method === "close_plugin_file_drop") {
        closedInstances.push(String(args.instanceId ?? ""));
        for (const resolve of closeWaiters) resolve(closedInstances.length);
        closeWaiters.clear();
        return undefined as T;
      }
      if (method === "discard_plugin_file_drop_intent") return undefined as T;
      throw new Error("Unexpected native fixture command: " + method);
    },
  };
}

export async function installPluginFileDropBrowserFixture() {
  const frame = document.getElementById("plugin-frame") as HTMLIFrameElement;
  const sources = new PluginFrameSourceRegistry();
  const router = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const webContentsId = router.reserve({ kind: "main" });
  const source = frame.contentWindow!;
  sources.setMain(source);
  const identity = sources.currentIdentityForHost(source)!;
  router.bind({ kind: "main" }, source, identity, true);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pluginId));
  const suffix = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 24);
  const native = createNativeDouble("atools.host.file-drop." + suffix);
  let currentStatus = "idle", statusVersion = 0;
  const statusWaiters = new Set<(value: number) => void>();
  let bridgeReadyResolve!: () => void;
  const bridgeReady = new Promise<void>(resolve => { bridgeReadyResolve = resolve; });
  const probeWaiters = new Map<string, (value: unknown) => void>();
  const loadWaiters = new Set<(count: number) => void>();
  const openWaiters = new Set<(count: number) => void>();
  const receiverMessages: Array<{ kind: string; origin: string }> = [];
  let bridgeOpenCount = 0, firstBridgeNonce: string | undefined, replacementNonceRotated = false;
  const host = createPluginPanelFileDropHost({ pluginId, isCurrent: () => true, invoke: native.invoke,
    listen: native.listen, iframe: () => frame, childFrames: new Map(), sources, hostedIpc: router,
    wait: async () => undefined,
    onStatus: message => {
      currentStatus = message ?? "ready"; statusVersion++;
      for (const resolve of statusWaiters) resolve(statusVersion);
      statusWaiters.clear();
    } });
  function waitStatus(after: number) {
    if (statusVersion > after) return Promise.resolve(statusVersion);
    return new Promise<number>(resolve => statusWaiters.add(resolve));
  }
  const readyListener = (event: MessageEvent) => {
    if (event.source !== source || !event.data || typeof event.data !== "object") return;
    const data = event.data as Record<string, unknown>;
    if (data.__atools_hosted_ipc_document__ === true) {
      const currentIdentity = sources.currentIdentityForHost(source);
      if (!currentIdentity) return;
      try { router.handleLifecycle({ source, identity: currentIdentity }, data); }
      catch (error) { currentStatus = "lifecycle-error:" + String((error as Error).message); return; }
      if (data.phase === "open") {
        try {
          router.captureReadyDocumentLease(source); bridgeReadyResolve();
          if (typeof data.documentNonce === "string") {
            if (!firstBridgeNonce) firstBridgeNonce = data.documentNonce;
            else if (data.documentNonce !== firstBridgeNonce) replacementNonceRotated = true;
          }
          bridgeOpenCount++;
          for (const resolve of [...openWaiters]) resolve(bridgeOpenCount);
        } catch { /* load/open ordering can require the next load event */ }
      }
      return;
    }
    if (data[marker] === true && typeof data.kind === "string") {
      receiverMessages.push({ kind: data.kind, origin: event.origin });
      probeWaiters.get(data.kind)?.(data.result);
      probeWaiters.delete(data.kind);
    }
  };
  window.addEventListener("message", readyListener);
  let loadCount = 0;
  frame.addEventListener("load", () => {
    loadCount++;
    const registered = router.registerFrame({ kind: "main" }, source, true, true);
    if (registered) {
      try { router.captureReadyDocumentLease(source); bridgeReadyResolve(); } catch { /* bridge lifecycle remains authoritative */ }
    }
    for (const resolve of [...loadWaiters]) resolve(loadCount);
  });
  frame.srcdoc = frameHtml(webContentsId);
  const started = host.start();
  function waitProbe(kind: string, timeoutMs = 5_000): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { probeWaiters.delete(kind); reject(new Error("Timed out waiting for frame probe: " + kind)); }, timeoutMs);
      probeWaiters.set(kind, value => { clearTimeout(timer); resolve(value); });
    });
  }
  function waitForLoadCount(count: number, timeoutMs = 5_000): Promise<number> {
    if (loadCount >= count) return Promise.resolve(loadCount);
    return new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (value: number) => {
        if (value < count) return;
        loadWaiters.delete(settle);
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        loadWaiters.delete(settle);
        reject(new Error(`Timed out waiting for iframe load count ${count}; observed ${loadCount}; status ${currentStatus}`));
      }, timeoutMs);
      loadWaiters.add(settle);
    });
  }
  function waitForOpenCount(count: number, timeoutMs = 5_000): Promise<number> {
    if (bridgeOpenCount >= count) return Promise.resolve(bridgeOpenCount);
    return new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (value: number) => {
        if (value < count) return;
        openWaiters.delete(settle);
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        openWaiters.delete(settle);
        reject(new Error(`Timed out waiting for bridge open count ${count}; observed ${bridgeOpenCount}; status ${currentStatus}`));
      }, timeoutMs);
      openWaiters.add(settle);
    });
  }
  function waitForCloseCount(count: number, timeoutMs = 5_000) {
    if (native.closedInstances.length >= count) return Promise.resolve(native.closedInstances.length);
    return new Promise<number>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (value: number) => {
        native.closeWaiters.delete(settle);
        clearTimeout(timer);
        if (value >= count) resolve(value);
      };
      timer = setTimeout(() => {
        native.closeWaiters.delete(settle);
        if (native.closedInstances.length >= count) resolve(native.closedInstances.length);
        else reject(new Error("Timed out waiting for the native mock close"));
      }, timeoutMs);
      native.closeWaiters.add(settle);
    });
  }
  async function drop(index: number) {
    await started; await bridgeReady;
    const entry = ids[index];
    const rect = frame.getBoundingClientRect(), scaleFactor = window.devicePixelRatio || 1;
    const intent: NativeDrop = { intentId: entry.intent, xPhysical: Math.round((rect.left + 24) * scaleFactor),
      yPhysical: Math.round((rect.top + 24) * scaleFactor), scaleFactor, fileCount: rows.length };
    const statusBefore = statusVersion;
    const onDrop = native.listeners.get("atools://plugin-file-drop");
    if (!onDrop) throw new Error("Native IPC double has no active file-drop listener");
    const probe = waitProbe("drop");
    onDrop({ payload: intent });
    await waitStatus(statusBefore);
    return await probe;
  }
  function probe(kind: string): Promise<unknown> {
    const pending = waitProbe(kind);
    source.postMessage({ [marker]: "query", kind }, "*");
    return pending;
  }
  async function invalidate() {
    const before = statusVersion;
    const listener = native.listeners.get("atools://plugin-file-drop-invalidated");
    if (!listener) throw new Error("Native invalidation listener is absent");
    listener({ payload: { pluginId } });
    await waitStatus(before);
    return await probe("invalidated");
  }
  async function expire() {
    const data = await drop(1);
    await new Promise(resolve => setTimeout(resolve, 1_350));
    return { data, query: await probe("expired") };
  }
  async function syntheticPagehide() {
    const pending = waitProbe("synthetic-pagehide-event");
    source.postMessage({ [marker]: "synthetic-pagehide" }, "*");
    return await pending;
  }
  async function replaceFrameDocument() {
    const targetLoad = loadCount + 1, targetOpen = bridgeOpenCount + 1;
    const registered = router.registerFrame({ kind: "main" }, source, true, false);
    if (!registered) throw new Error(`Could not reserve replacement iframe binding; load ${loadCount}; open ${bridgeOpenCount}; status ${currentStatus}`);
    const load = waitForLoadCount(targetLoad), open = waitForOpenCount(targetOpen);
    frame.srcdoc = frameHtml(webContentsId);
    await Promise.all([load, open]);
    return { kind: "replacement-document-open", loadCount, bridgeOpenCount, replacementNonceRotated };
  }
  async function close() {
    await host.close();
    router.invalidate({ kind: "main" }, true, source);
    router.clear();
    sources.clear();
    window.removeEventListener("message", readyListener);
    frame.remove();
    return { nativeListeners: native.listeners.size, frameRemoved: !frame.isConnected, status: currentStatus,
      deliveredBuffersDetached: native.delivered.map(buffer => buffer.byteLength === 0),
      closeCalls: native.calls.filter(call => call.method === "close_plugin_file_drop").length,
      nativeMethods: native.calls.map(call => call.method),
      receiverMessages: receiverMessages.slice(), loadCount };
  }
  return { ready: bridgeReady, drop, probe, invalidate, expire, syntheticPagehide, replaceFrameDocument, close,
    waitForCloseCount,
    get lifecycleDiagnostics() { return { loadCount, bridgeOpenCount, replacementNonceRotated, currentStatus }; },
    get transferDetached() { return native.delivered.map(buffer => buffer.byteLength === 0); },
    get deliveries() { return native.delivered.length; }, get status() { return currentStatus; } };
}

declare global { interface Window { pluginFileDropBrowserFixture?: Awaited<ReturnType<typeof installPluginFileDropBrowserFixture>> } }
void installPluginFileDropBrowserFixture().then(fixture => { window.pluginFileDropBrowserFixture = fixture; });
