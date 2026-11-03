type ExportWindow = Window & {
  console: Pick<Console, "error">;
  exports?: Record<string, unknown>;
  ztools?: { setSubInput: (callback: (value: { text: string }) => void, placeholder: string, focus: boolean) => unknown; removeSubInput: () => unknown };
  __ATOOLS_FRAME_TRANSPORT__?: { post: (message: Record<string, unknown>) => unknown; accept: (event: MessageEvent) => boolean };
};

/** Serialized into the plugin document. Raw items and callbacks never leave it. */
export function createPluginFeatureExportsBridge(target: ExportWindow, epoch: number) {
  type Action = Record<string, unknown>;
  type Args = { enter?: (action: Action, callback?: (items: unknown) => void) => unknown;
    search?: (action: Action, text: string, callback: (items: unknown) => void) => unknown;
    select?: (action: Action, item: unknown, callback: (items: unknown) => void) => unknown; placeholder?: string };
  let disposed = false, started = false, entry = 0, revision = 0, operation = 0, busy = false, lastActivationId = 0;
  let action: Action = {}, args: Args = {}, items: unknown[] = [], mode = "";
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  function post(payload: Record<string, unknown>) {
    if (disposed) return;
    const message = { __atools_feature_exports__: true, epoch, entry, revision, mode, ...payload };
    if (target.__ATOOLS_FRAME_TRANSPORT__) target.__ATOOLS_FRAME_TRANSPORT__.post(message);
    else target.parent.postMessage(message, "*");
  }
  function fail(error: unknown, owner = operation) {
    if (disposed || owner !== operation) return;
    const text = String(error instanceof Error ? error.message : error).slice(0, 2048);
    post({ error: text || "插件列表执行失败", busy: false });
    target.console.error("[ATools feature exports]", error);
  }
  function valid(owner: number) { return !disposed && owner === operation; }
  function assertJsonBudget(value: unknown) {
    const ancestors = new Set<object>();
    let bytes = 0, nodes = 0;
    function visit(current: unknown, depth: number) {
      if (++nodes > 65536 || depth > 32) throw Error("ERR_ATOOLS_FEATURE_LIST_COMPLEXITY");
      if (typeof current === "string") {
        if (current.length > 1048576) throw Error("ERR_ATOOLS_FEATURE_LIST_BYTES: 列表最多 1 MiB");
        bytes += new TextEncoder().encode(current).byteLength + 2;
        for (let index = 0; index < current.length; index += 1) {
          const unit = current.charCodeAt(index);
          if (unit < 32) bytes += [8, 9, 10, 12, 13].includes(unit) ? 1 : 5;
          else if (unit === 34 || unit === 92) bytes += 1;
          else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = current.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index += 1;
            else bytes += 3;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 3;
        }
      } else if (current === null || typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) bytes += String(current).length;
      else if (current && typeof current === "object") {
        if (ancestors.has(current)) throw Error("ERR_ATOOLS_FEATURE_LIST_JSON: 循环引用");
        ancestors.add(current);
        let prototype: object | null = current;
        for (let level = 0; prototype; level += 1, prototype = Object.getPrototypeOf(prototype)) {
          if (level > 32) throw Error("ERR_ATOOLS_FEATURE_LIST_COMPLEXITY");
          if (Object.getOwnPropertyDescriptor(prototype, "toJSON"))
            throw Error("ERR_ATOOLS_FEATURE_LIST_JSON: 不支持自定义 JSON 转换");
        }
        if (Array.isArray(current)) {
          const length = current.length;
          if (length > 65536 || nodes + length > 65536 || (length > 0 && depth + 1 > 32))
            throw Error("ERR_ATOOLS_FEATURE_LIST_COMPLEXITY");
          bytes += 2 + Math.max(0, length - 1);
          for (let index = 0; index < length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
            if (!descriptor) {
              // JSON fills holes with null, but may otherwise read an inherited getter.
              if (index in current) throw Error("ERR_ATOOLS_FEATURE_LIST_JSON: 不支持继承的数组元素");
              if (++nodes > 65536) throw Error("ERR_ATOOLS_FEATURE_LIST_COMPLEXITY");
              bytes += 4;
            } else {
              if (!("value" in descriptor)) throw Error("ERR_ATOOLS_FEATURE_LIST_JSON: 仅支持 JSON 数据");
              visit(descriptor.value, depth + 1);
            }
          }
        } else {
          const keys = Object.keys(current);
          if (keys.length > 65536 || nodes + keys.length * 2 > 65536) throw Error("ERR_ATOOLS_FEATURE_LIST_COMPLEXITY");
          bytes += 2 + keys.length + Math.max(0, keys.length - 1);
          for (const key of keys) {
            visit(key, depth + 1);
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (!descriptor || !("value" in descriptor)) throw Error("ERR_ATOOLS_FEATURE_LIST_JSON: 仅支持 JSON 数据");
            visit(descriptor.value, depth + 1);
          }
        }
        ancestors.delete(current);
      } else throw Error("ERR_ATOOLS_FEATURE_LIST_JSON: 仅支持 JSON 数据");
      if (bytes > 1048576) throw Error("ERR_ATOOLS_FEATURE_LIST_BYTES: 列表最多 1 MiB");
    }
    visit(value, 0);
  }
  function invoke(callback: () => unknown, owner: number, finished?: () => void) {
    try {
      Promise.resolve(callback()).then(() => { if (valid(owner)) finished?.(); }, error => {
        if (valid(owner)) { finished?.(); fail(error, owner); }
      });
    } catch (error) { if (valid(owner)) { finished?.(); fail(error, owner); } }
  }
  function setList(owner: number) {
    return (value: unknown) => {
      if (!valid(owner)) return;
      try {
        if (!Array.isArray(value) || value.length > 2000) throw Error("ERR_ATOOLS_FEATURE_LIST_COUNT: 最多 2000 项");
        assertJsonBudget(value);
        const encoded = JSON.stringify(value);
        if (!encoded || new TextEncoder().encode(encoded).byteLength > 1048576)
          throw Error("ERR_ATOOLS_FEATURE_LIST_BYTES: 列表最多 1 MiB");
        const rows = value.map((item, index) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("ERR_ATOOLS_FEATURE_LIST_ITEM");
          const row = item as Record<string, unknown>;
          for (const key of ["title", "description", "icon"])
            if (row[key] !== undefined && (typeof row[key] !== "string" || (row[key] as string).length > 8192))
              throw Error("ERR_ATOOLS_FEATURE_LIST_FIELD: " + key);
          return { index, title: String(row.title ?? ""), description: String(row.description ?? ""), icon: String(row.icon ?? "") };
        });
        items = value.slice();
        revision += 1;
        post({ rows, busy });
      } catch (error) { items = []; revision += 1; post({ rows: [], busy: false }); fail(error, owner); }
    };
  }
  function search(text: string) {
    if (disposed || mode !== "list" || typeof args.search !== "function") return;
    const owner = ++operation;
    busy = false; items = []; revision += 1;
    post({ rows: [], busy: false });
    invoke(() => args.search!(action, text, setList(owner)), owner);
  }
  function select(index: number) {
    if (disposed || busy || mode !== "list" || !Number.isSafeInteger(index) || index < 0 || index >= items.length || typeof args.select !== "function") return;
    const owner = ++operation;
    busy = true; post({ busy: true });
    invoke(() => args.select!(action, items[index], setList(owner)), owner, () => { busy = false; post({ busy: false }); });
  }
  function receive(event: MessageEvent) {
    if (disposed || event.source !== target.parent) return;
    if (target.__ATOOLS_FRAME_TRANSPORT__ && !target.__ATOOLS_FRAME_TRANSPORT__.accept(event)) return;
    const data = event.data;
    if (!data || data.__atools_feature_exports_command__ !== true || data.epoch !== epoch
      || data.entry !== entry || data.revision !== revision) return;
    if (data.command === "select") select(data.index);
  }
  function keydown(event: KeyboardEvent) {
    if (disposed || mode !== "list" || event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const node = event.target as HTMLElement | null;
    if (node?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    const intent = ({ ArrowUp: "previous", ArrowDown: "next", Home: "first", End: "last", Enter: "activate" } as Record<string, string>)[event.key];
    if (!intent) return;
    event.preventDefault(); event.stopPropagation(); post({ intent });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; operation += 1; items = []; args = {}; busy = false;
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    target.removeEventListener("message", receive);
    target.removeEventListener("keydown", keydown);
    target.removeEventListener("atools-plugin-out", dispose);
    target.removeEventListener("pagehide", dispose);
  }
  function activate(nextAction: Action, announceReady: boolean, resetEntry: boolean) {
    if (disposed) return;
    if (resetEntry) {
      operation += 1; items = []; args = {}; busy = false; mode = ""; revision += 1;
      try { target.ztools?.removeSubInput(); } catch (error) { target.console.error("[ATools feature exports] subinput reset failed", error); }
    }
    action = nextAction && typeof nextAction === "object" ? nextAction : {};
    entry += 1;
    const code = String(action.code ?? "");
    let feature: unknown;
    try {
      const exports = target.exports;
      feature = exports && Object.prototype.hasOwnProperty.call(exports, code) ? exports[code] : undefined;
    } catch (error) { mode = "none"; fail(error); return; }
    if (!feature || typeof feature !== "object" || !["list", "none"].includes(String((feature as { mode?: unknown }).mode))) {
      target.dispatchEvent(new CustomEvent("atools-plugin-enter", { detail: action }));
      if (announceReady) readyTimer = setTimeout(() => { if (!disposed) target.dispatchEvent(new Event("atools-plugin-ready")); }, 50);
      return;
    }
    mode = String((feature as { mode: unknown }).mode);
    const candidate = (feature as { args?: unknown }).args;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { fail(Error("ERR_ATOOLS_FEATURE_ARGS")); return; }
    args = candidate as Args;
    post({ rows: [], busy: mode === "none", selectable: mode === "list" && typeof args.select === "function" });
    const owner = ++operation;
    if (mode === "list") {
      if (args.placeholder !== undefined && (typeof args.placeholder !== "string" || args.placeholder.length > 8192)) {
        fail(Error("ERR_ATOOLS_FEATURE_PLACEHOLDER"), owner); return;
      }
      if (typeof args.search === "function") target.ztools?.setSubInput(details => search(String(details.text ?? "")), args.placeholder || "搜索", true);
      else target.ztools?.removeSubInput();
      if (typeof args.enter === "function") invoke(() => args.enter!(action, setList(owner)), owner);
    } else if (typeof args.enter === "function") {
      invoke(() => args.enter!(action), owner, () => post({ busy: false }));
    } else fail(Error("ERR_ATOOLS_FEATURE_ENTER"), owner);
  }
  target.addEventListener("message", receive);
  target.addEventListener("keydown", keydown);
  target.addEventListener("atools-plugin-out", dispose);
  target.addEventListener("pagehide", dispose);
  return {
    start(nextAction: Action) {
      if (disposed || started) return;
      started = true;
      activate(nextAction, true, false);
    },
    reenter(nextAction: Action, activationId: number) {
      if (disposed || !Number.isSafeInteger(activationId) || activationId <= lastActivationId) return false;
      lastActivationId = activationId;
      started = true;
      activate(nextAction, false, true);
      return true;
    },
    dispose,
  };
}
