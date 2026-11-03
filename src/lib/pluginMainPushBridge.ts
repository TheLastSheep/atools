import { createPluginMainPushBudget } from "./pluginMainPushBudget";
import { createPluginMainPushPresentation } from "./pluginMainPushPresentation";

type FrameWindow = Window & { __ATOOLS_FRAME_TRANSPORT__?: { post: (data: Record<string, unknown>) => unknown; accept: (event: MessageEvent) => boolean } };
type Config = { runnerId: string; nonce: string; epoch: number; featureCode: string; parentOrigin: string; queryOnly: boolean };

/** Serialized factory: callbacks and raw options belong to this original document only. */
export function createPluginMainPushBridge(target: FrameWindow, config: Config,
  budgetFactory = createPluginMainPushBudget, presentationFactory = createPluginMainPushPresentation) {
  const budget = budgetFactory();
  const presentation = config.queryOnly ? presentationFactory(target) : undefined;
  let disposed = false, callback: ((action: Record<string, unknown>) => unknown) | null = null;
  let selectCallback: ((action: Record<string, unknown>) => unknown) | null = null;
  let operation = 0, queryId = "", generation = 0, entered = false;
  let snapshot: { code: string; type: string; payload: string; from: string } | undefined;
  const options = new Map<string, unknown>(), consumed = new Set<string>();
  function post(data: Record<string, unknown>) {
    if (disposed) return;
    const message = { __atools_main_push__: true, runnerId: config.runnerId, nonce: config.nonce, epoch: config.epoch, ...data };
    if (target.__ATOOLS_FRAME_TRANSPORT__) target.__ATOOLS_FRAME_TRANSPORT__.post(message);
    else target.parent.postMessage(message, config.parentOrigin);
  }
  function own(item: object, key: string) { const value = Object.getOwnPropertyDescriptor(item, key); return value && "value" in value ? value.value : undefined; }
  function text(value: unknown) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" && typeof value !== "number") throw Error("ERR_MAIN_PUSH_FIELD");
    const result = String(value);
    if (result.length > 4096) throw Error("ERR_MAIN_PUSH_FIELD");
    return result;
  }
  function normalize(returned: unknown) {
    if (returned === undefined || returned === null) return [];
    budget.assert(returned);
    const list = Array.isArray(returned) ? returned : typeof returned === "object" && own(returned, "type") === "list" ? own(returned, "data") : [];
    if (!Array.isArray(list)) throw Error("ERR_MAIN_PUSH_LIST");
    const rows: Array<{ handle: string; text: string; description: string; icon: string; highlight: boolean }> = [];
    for (const item of list.slice(0, 20)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("ERR_MAIN_PUSH_ITEM");
      budget.assert(item, 16384);
      const handle = `${queryId}:${rows.length}`;
      const label = text(own(item, "text"));
      if (!label) continue;
      rows.push({ handle, text: label, description: text(own(item, "title") ?? own(item, "description")),
        icon: text(own(item, "icon")), highlight: own(item, "highlight") !== false });
      options.set(handle, item);
    }
    return rows;
  }
  function current(owner: number) { return !disposed && owner === operation; }
  async function query(data: Record<string, unknown>) {
    const owner = ++operation;
    options.clear(); consumed.clear();
    queryId = String(data.requestId); generation = Number(data.generation);
    snapshot = { code: config.featureCode, type: String(data.type), payload: data.payload as string, from: "main" };
    presentation?.setMode("query");
    try {
      const result = callback ? await callback({ ...snapshot }) : undefined;
      if (!current(owner)) return;
      const rows = normalize(result);
      post({ requestId: data.requestId, generation, outcome: rows.length ? "ready" : "empty", rows });
    } catch {
      if (current(owner)) { options.clear(); post({ requestId: data.requestId, generation, outcome: "failed", error: "ERR_MAIN_PUSH_QUERY" }); }
    }
  }
  async function select(data: Record<string, unknown>) {
    if (data.queryId !== queryId || data.generation !== generation || !snapshot || typeof data.handle !== "string"
      || !options.has(data.handle) || consumed.has(data.handle)) {
      post({ requestId: data.requestId, outcome: "superseded" }); return;
    }
    consumed.add(data.handle);
    const owner = ++operation;
    presentation?.setMode("select");
    try {
      const result = selectCallback ? await selectCallback({ ...snapshot, option: options.get(data.handle) }) : undefined;
      if (current(owner)) post({ requestId: data.requestId, generation, outcome: result === true ? "enter" : "handled", shouldEnter: result === true });
    } catch { if (current(owner)) post({ requestId: data.requestId, generation, outcome: "failed", error: "ERR_MAIN_PUSH_SELECT" }); }
    finally { if (current(owner)) presentation?.setMode("query"); }
  }
  function receive(event: MessageEvent) {
    if (disposed || event.source !== target.parent || event.origin !== config.parentOrigin
      || target.__ATOOLS_FRAME_TRANSPORT__ && !target.__ATOOLS_FRAME_TRANSPORT__.accept(event)) return;
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data) || data.__atools_main_push_command__ !== true
      || data.runnerId !== config.runnerId || data.nonce !== config.nonce || data.epoch !== config.epoch) return;
    if (data.command === "cancel") { operation++; options.clear(); consumed.clear(); snapshot = undefined; presentation?.setMode("query"); return; }
    if (data.command === "query" && typeof data.requestId === "string" && data.requestId.length <= 128
      && typeof data.payload === "string" && data.payload.length <= 262144 && new TextEncoder().encode(data.payload).byteLength <= 262144
      && ["text", "regex", "over"].includes(data.type) && Number.isSafeInteger(data.generation) && data.generation >= 0) void query(data);
    if (data.command === "select" && typeof data.requestId === "string" && data.requestId.length <= 128) void select(data);
    if (data.command === "promote" && !entered && snapshot && data.queryId === queryId
      && (!Object.prototype.hasOwnProperty.call(data, "handle") || options.has(data.handle))) {
      entered = true; operation++;
      presentation?.setMode("visible");
      const action: Record<string, unknown> = { ...snapshot };
      if (Object.prototype.hasOwnProperty.call(data, "handle")) action.option = options.get(data.handle);
      target.dispatchEvent(new CustomEvent("atools-main-push-promote", { detail: action }));
      options.clear(); consumed.clear();
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; operation++; options.clear(); consumed.clear(); callback = selectCallback = null;
    presentation?.dispose();
    target.removeEventListener("message", receive); target.removeEventListener("pagehide", dispose);
  }
  target.addEventListener("message", receive); target.addEventListener("pagehide", dispose, { once: true });
  return { register(next: unknown, select: unknown) {
    if (disposed) return;
    callback = typeof next === "function" ? next as typeof callback : null;
    selectCallback = typeof select === "function" ? select as typeof selectCallback : null;
    post({ registered: Boolean(callback) });
  }, boot() { post({ booted: true, registered: Boolean(callback) }); }, dispose };
}
