import assert from "node:assert/strict";
import type { CdpClient } from "../../../scripts/chrome-cdp-smoke-utils.mjs";

const queryChannel = "pasteboard-pro:history-query";
const resultEvent = "pasteboard-pro:history-result";
const bindingName = "__atoolsPasteShelfHistoryRelay";

export type PasteShelfHistoryRequest = Record<string, unknown>;
export type PasteShelfHistoryRelayEntry = {
  sequence: number;
  queryLength: number;
  limit: number | null;
  hasCursor: boolean;
  outcome: "pending" | "returned" | "rejected";
  resultShape?: PasteShelfHistoryResultShape;
  itemCount?: number;
  total?: number;
  error?: string;
};
export type PasteShelfHistoryResultShape = {
  cdpResult: { type: string | null; subtype: string | null; description: string | null };
  value: { present: boolean; type: string; ownKeys: string[]; ownKeyCount: number };
  items: { present: boolean; type: string; isArray: boolean; ownKeys: string[]; ownKeyCount: number; length: number | null };
  total: { present: boolean; type: string; numericValue: number | null };
};
export type PasteShelfHistoryRelayReport = {
  mode: string;
  parentIpcTested: false;
  nonceValidation: "shape-only; no native identity authorization";
  primaryDataSource: "original-primary-preload-searchHistoryPage";
  primaryDataMechanism: "PluginData db.allDocs through original HistorySearchService";
  serialization: "original-native-JSON-semantics; CDP-string-boundary";
  hopCount: number;
  requests: PasteShelfHistoryRelayEntry[];
  rejectedNativeCalls: Array<{ role: "shelf"; method: string; channel?: string; reason: string }>;
};
type HistoryPage = { items: unknown[]; total: number; [key: string]: unknown };

/** Routes only the original Shelf history request through the original primary preload API. */
export function createPasteShelfHistoryRelay(
  shelfPage: CdpClient,
  primaryPage: CdpClient,
  report: PasteShelfHistoryRelayReport,
  onFailure: (message: string) => void,
) {
  const pending = new Set<Promise<void>>();
  const pendingIds = new Set<string>();
  let sequence = 0;
  let disposed = false;
  let scriptId: string | undefined;
  const run = (method: string, params: Record<string, unknown> = {}, timeoutMs = 12_000) =>
    shelfPage.send(method, params, { timeoutMs });

  shelfPage.on("Runtime.bindingCalled", (event: any) => {
    if (disposed || event.name !== bindingName) return;
    const task = handleNativeBinding(String(event.payload ?? "")).catch(error => {
      onFailure(sanitizeDiagnostic(`Shelf history relay failed: ${String(error)}`) as string);
    }).finally(() => pending.delete(task));
    pending.add(task);
  });

  async function enable() {
    await run("Runtime.addBinding", { name: bindingName });
    const installed = await run("Page.addScriptToEvaluateOnNewDocument", { source: shelfNativePortSource() });
    scriptId = typeof installed.identifier === "string" ? installed.identifier : undefined;
  }

  async function handleNativeBinding(raw: string) {
    let message: any;
    try { message = JSON.parse(raw); }
    catch { throw new Error("Shelf native observer payload was not JSON"); }
    if (!message || typeof message !== "object" || message.kind !== "native-call") return;
    const args = message.args;
    const channel = args && typeof args.channel === "string" ? args.channel : undefined;
    const valid = message.exactEnvelope === true && message.method === "sendToParent"
      && channel === queryChannel && Array.isArray(args.args) && args.args.length === 2
      && args.windowType === "browserWindow" && typeof args.browserWindowId === "string"
      && args.browserWindowId.length > 0 && args.browserWindowId.length <= 128
      && Number.isSafeInteger(message.reqId) && message.reqId > 0 && validRequest(args.args[1]);
    if (!valid) {
      const reason = channel === queryChannel ? "invalid history query envelope" : "native call is outside the exact history-query channel";
      report.rejectedNativeCalls.push({ role: "shelf", method: String(message.method ?? ""),
        ...(channel ? { channel } : {}), reason });
      await respondNative(message.reqId, "ERR_ATOOLS_FIXTURE_NATIVE_CALL_DENIED");
      return;
    }

    const requestId = message.reqId as number;
    const id = args.args[0];
    if (typeof id !== "string" || id.length === 0 || id.length > 128 || pendingIds.has(id) || pending.size >= 16) {
      report.rejectedNativeCalls.push({ role: "shelf", method: "sendToParent", channel,
        reason: "invalid, duplicate, or over-budget history request id" });
      await respondNative(requestId, "ERR_ATOOLS_FIXTURE_HISTORY_QUERY_REJECTED");
      return;
    }

    pendingIds.add(id);
    const request = args.args[1] as PasteShelfHistoryRequest;
    const query = typeof request.query === "string" ? request.query : "";
    const limit = typeof request.limit === "number" && Number.isInteger(request.limit) ? request.limit : null;
    const entry: PasteShelfHistoryRelayEntry = {
      sequence: ++sequence,
      queryLength: query.length,
      limit,
      hasCursor: Object.prototype.hasOwnProperty.call(request, "cursor"),
      outcome: "pending",
    };
    report.hopCount++;
    report.requests.push(entry);
    try {
      const page = await queryOriginalPrimary(primaryPage, request, shape => { entry.resultShape = shape; });
      entry.outcome = "returned";
      entry.itemCount = page.items.length;
      entry.total = page.total;
      await dispatchResult(id, { page });
      await respondNative(requestId, null);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      entry.outcome = "rejected";
      entry.error = sanitizeDiagnostic(messageText) as string;
      await dispatchResult(id, { error: messageText });
      await respondNative(requestId, null);
      throw error;
    } finally { pendingIds.delete(id); }
  }

  async function queryOriginalPrimary(
    primary: CdpClient,
    request: PasteShelfHistoryRequest,
    recordShape: (shape: PasteShelfHistoryResultShape) => void,
  ): Promise<HistoryPage> {
    const encodedRequest = JSON.stringify(JSON.stringify(request));
    const expression = `(async()=>JSON.stringify(await window.pasteboardPro.searchHistoryPage(JSON.parse(${encodedRequest}))))()`;
    const response = await primary.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    }, { timeoutMs: 35_000 });
    recordShape(summarizeHistoryResultShape(response));
    assert.ok(!response.exceptionDetails,
      response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || "Primary history service rejected the request");
    const serializedPage = response.result?.value;
    if (typeof serializedPage !== "string") {
      throw new TypeError("Original primary history result did not serialize to JSON text");
    }
    if (Buffer.byteLength(serializedPage, "utf8") > 1_048_576) {
      throw new RangeError("Original primary HistoryPage exceeded the 1 MiB fixture relay bound");
    }
    let value: unknown;
    try { value = JSON.parse(serializedPage); }
    catch { throw new TypeError("Original primary history result was not valid JSON text"); }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Array.isArray((value as Record<string, unknown>).items)
      || !Number.isFinite((value as Record<string, unknown>).total)) {
      throw new TypeError("Original primary searchHistoryPage returned an invalid HistoryPage");
    }
    return value as HistoryPage;
  }

  async function dispatchResult(id: string, result: { page?: HistoryPage; error?: string }) {
    const reply = JSON.stringify({ id, ...result });
    const expression = `window.dispatchEvent(new CustomEvent(${JSON.stringify(resultEvent)},{detail:JSON.parse(${JSON.stringify(reply)})}));true`;
    await run("Runtime.evaluate", { expression, returnByValue: true }, 12_000);
  }

  async function respondNative(reqId: unknown, error: string | null) {
    if (!Number.isSafeInteger(reqId) || Number(reqId) <= 0) return;
    const response = error === null
      ? { __atools_native_response__: true, reqId, result: null }
      : { __atools_native_response__: true, reqId, error };
    const expression = `window.postMessage(JSON.parse(${JSON.stringify(JSON.stringify(response))}),'*');true`;
    await run("Runtime.evaluate", { expression, returnByValue: true }, 12_000);
  }

  async function settle(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (pending.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Shelf history relay cleanup could not confirm ${pending.size} request(s)`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const complete = await Promise.race([
        Promise.allSettled([...pending]).then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!complete && pending.size > 0) {
        throw new Error(`Shelf history relay cleanup timed out with ${pending.size} request(s) still active`);
      }
    }
  }

  async function dispose() {
    if (disposed) return;
    await settle();
    disposed = true;
    const failures: unknown[] = [];
    try { if (scriptId) await run("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }); }
    catch (error) { if (!isDestroyedTarget(shelfPage, error)) failures.push(error); }
    try { await run("Runtime.evaluate", { expression: "window.__atoolsPasteShelfFixturePort?.dispose?.()", returnByValue: true }); }
    catch (error) { if (!isDestroyedTarget(shelfPage, error)) failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Paste Shelf history relay cleanup failed");
  }

  return { enable, settle, dispose, get pendingCount() { return pending.size; } };
}

function summarizeHistoryResultShape(response: any): PasteShelfHistoryResultShape {
  const cdpResult = response?.result;
  const valuePresent = !!cdpResult && Object.prototype.hasOwnProperty.call(cdpResult, "value");
  const value = valuePresent ? cdpResult.value : undefined;
  const valueObject = value !== null && (typeof value === "object" || typeof value === "function");
  const valueKeys = ownKeys(valueObject ? value : undefined);
  const itemsPresent = valueObject && Object.prototype.hasOwnProperty.call(value, "items");
  const items = itemsPresent ? value.items : undefined;
  const itemsObject = items !== null && (typeof items === "object" || typeof items === "function");
  const itemKeys = ownKeys(itemsObject ? items : undefined);
  const totalPresent = valueObject && Object.prototype.hasOwnProperty.call(value, "total");
  const total = totalPresent ? value.total : undefined;
  return {
    cdpResult: {
      type: safeShapeLabel(cdpResult?.type),
      subtype: safeShapeLabel(cdpResult?.subtype),
      description: safeDescription(cdpResult?.description),
    },
    value: { present: valuePresent, type: typeof value, ownKeys: valueKeys.slice(0, 20), ownKeyCount: valueKeys.length },
    items: {
      present: itemsPresent, type: typeof items, isArray: Array.isArray(items),
      ownKeys: itemKeys.slice(0, 20), ownKeyCount: itemKeys.length,
      length: Array.isArray(items) ? items.length : null,
    },
    total: {
      present: totalPresent, type: typeof total,
      numericValue: typeof total === "number" && Number.isFinite(total) ? total : null,
    },
  };
}

function ownKeys(value: unknown): string[] {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return [];
  try { return Object.keys(value).slice(0, 21); } catch { return []; }
}

function safeShapeLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.() -]{1,64}$/u.test(value) ? value : null;
}

function safeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const description = value.slice(0, 80);
  return /^(?:Object|Array(?:\(\d+\))?|Function(?: [A-Za-z_$][\w$]*)?|Error|undefined|null|boolean|number|string|symbol|BigInt(?:\(\d+\))?)$/u.test(description)
    ? description : "<omitted-nonshape-description>";
}

function shelfNativePortSource() {
  return `(function(){
    var old=window.__atoolsPasteShelfFixturePort;if(old&&typeof old.dispose==='function')old.dispose();
    var state={totalMessageCount:0,nativeCallCount:0,selfSourceCount:0,foreignSourceCount:0,latest:null};
    function bump(name){state[name]=Math.min(state[name]+1,1000000);}
    function summaryText(value){return typeof value==='string'?value.slice(0,128):null;}
    function keys(value){return value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';}
    function onMessage(event){
      bump('totalMessageCount');
      var selfSource=event.source===window;bump(selfSource?'selfSourceCount':'foreignSourceCount');
      var message=event.data;
      if(!message||typeof message!=='object'||message.__atools_native_call__!==true)return;
      bump('nativeCallCount');
      var args=message.args||{};var exact=keys(message)==='__atools_native_call__,args,hostedDocumentNonce,method,reqId'
        &&message.method==='sendToParent'&&keys(args)==='args,browserWindowId,channel,windowType'
        &&Number.isSafeInteger(message.reqId)&&message.reqId>0
        &&typeof message.hostedDocumentNonce==='string'&&/^[0-9a-f]{32}$/.test(message.hostedDocumentNonce);
      state.latest={source:selfSource?'self':'foreign',method:summaryText(message.method),
        channel:summaryText(args.channel),argCount:Array.isArray(args.args)?Math.min(args.args.length,1000):null};
      if(!selfSource)return;
      window.${bindingName}(JSON.stringify({kind:'native-call',exactEnvelope:exact,reqId:message.reqId,
        method:String(message.method||''),args:args}));
    }
    window.addEventListener('message',onMessage);
    Object.defineProperty(window,'__atoolsPasteShelfFixturePort',{configurable:true,value:{
      get state(){return {totalMessageCount:state.totalMessageCount,nativeCallCount:state.nativeCallCount,
        selfSourceCount:state.selfSourceCount,foreignSourceCount:state.foreignSourceCount,
        latest:state.latest&&Object.assign({},state.latest)};},
      dispose:function(){window.removeEventListener('message',onMessage);}
    }});
  })();`;
}

function validRequest(value: unknown): value is PasteShelfHistoryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" && Buffer.byteLength(encoded, "utf8") <= 16_384;
  } catch { return false; }
}

function isDestroyedTarget(page: CdpClient, error: unknown) {
  const client = page as unknown as { ws?: { socket?: { destroyed?: boolean } } };
  return client.ws?.socket?.destroyed === true || String(error).includes("Target closed");
}

function sanitizeDiagnostic(value: unknown): unknown {
  if (typeof value === "string") return value
    .replace(/(\/(?:node|data|host|secrets)\/)[a-f0-9]{64}(?=\/|[?#\s]|$)/giu, "$1<redacted>")
    .replace(/\b[a-f0-9]{64}\b/giu, "<redacted>");
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDiagnostic(item)]));
  return value;
}
