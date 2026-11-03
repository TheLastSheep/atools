export type PluginFeatureRow = { index: number; title: string; description: string; icon: string };
export type PluginFeatureList = { mode: "list" | "none" | ""; epoch: number; entry: number; revision: number;
  rows: PluginFeatureRow[]; selected: number; busy: boolean; error: string; keyboard: boolean; selectable: boolean };
export type PluginFeatureIntent = "previous" | "next" | "first" | "last" | "activate";
export function emptyPluginFeatureList(epoch = 0): PluginFeatureList {
  return { mode: "", epoch, entry: 0, revision: 0, rows: [], selected: 0, busy: false, error: "", keyboard: false, selectable: false };
}
export function featureListMessage(state: PluginFeatureList, value: unknown): PluginFeatureList | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.__atools_feature_exports__ !== true) return null;
  if (data.epoch !== state.epoch || !Number.isSafeInteger(data.entry) || Number(data.entry) < 1
    || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0
    || !["list", "none"].includes(String(data.mode))) return state;
  if (Number(data.entry) < state.entry || (data.entry === state.entry && Number(data.revision) < state.revision)) return state;
  let next = { ...state, mode: data.mode as "list" | "none", entry: Number(data.entry), revision: Number(data.revision) };
  if (data.rows !== undefined) {
    if (!Array.isArray(data.rows) || data.rows.length > 2000) return { ...next, rows: [], error: "插件列表超出数量限制" };
    const rows: PluginFeatureRow[] = [];
    let bytes = 0;
    for (const [index, row] of data.rows.entries()) {
      if (!row || typeof row !== "object" || row.index !== index
        || [row.title, row.description, row.icon].some(value => typeof value !== "string" || value.length > 8192))
        return { ...next, rows: [], error: "插件列表格式不正确" };
      bytes += new TextEncoder().encode(row.title + row.description + row.icon).byteLength;
      if (bytes > 1048576) return { ...next, rows: [], error: "插件列表超出大小限制" };
      rows.push({ index, title: row.title, description: row.description, icon: row.icon });
    }
    next = { ...next, rows, selected: 0, keyboard: false, error: "" };
  }
  if (typeof data.busy === "boolean") next.busy = data.busy;
  if (typeof data.selectable === "boolean") next.selectable = data.selectable;
  if (typeof data.error === "string") { next.error = data.error.slice(0, 2048); next.busy = false; }
  return next;
}
export function moveFeatureList(state: PluginFeatureList, intent: Exclude<PluginFeatureIntent, "activate">): PluginFeatureList {
  if (state.mode !== "list" || !state.rows.length) return state;
  const last = state.rows.length - 1;
  const selected = intent === "first" ? 0 : intent === "last" ? last
    : (state.selected + (intent === "previous" ? -1 : 1) + state.rows.length) % state.rows.length;
  return { ...state, selected, keyboard: true };
}
export function selectFeatureListCommand(state: PluginFeatureList, index = state.selected) {
  return state.mode === "list" && state.selectable && !state.busy && Number.isSafeInteger(index) && index >= 0 && index < state.rows.length
    ? { __atools_feature_exports_command__: true, epoch: state.epoch, entry: state.entry, revision: state.revision, command: "select", index } : null;
}
