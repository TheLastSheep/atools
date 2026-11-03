type ClipboardError = (code: string, message: string) => Error;
type HistoryInvoke = (access: "history_read" | "history_delete", payload: Record<string, unknown>, maxResponseBytes?: number) => unknown;

/** Validates the narrow history protocol before it reaches the permissioned session transport. */
export function createHostClipboardHistoryApi(invoke: HistoryInvoke, failure: ClipboardError) {
  const idIsValid = (id: unknown) => typeof id === "string"
    && /^clip-(?:[0-9a-f]{16}|image-[0-9a-f]{16}|file-[0-9a-f]{16})$/.test(id);
  const exactKeys = (payload: Record<string, unknown>, allowed: string[]) =>
    Object.keys(payload).every((key) => allowed.includes(key));
  function invalid(): never { throw failure("ERR_ATOOLS_HOST_CLIPBOARD_ARGUMENT", "Invalid clipboard history request"); }
  function historyRead(payload: Record<string, unknown>) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.operation !== "string") return invalid();
    if (payload.operation === "list") {
      const { page, pageSize, query } = payload;
      if (!exactKeys(payload, ["operation", "page", "pageSize", "query"])
        || typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > 1000001
        || typeof pageSize !== "number" || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000
        || (page - 1) * pageSize > 10000000
        || (query !== undefined && (typeof query !== "string" || new TextEncoder().encode(query).length > 256))) return invalid();
    } else if (payload.operation === "getContent") {
      if (!exactKeys(payload, ["operation", "id"]) || !idIsValid(payload.id)) return invalid();
    } else return invalid();
    return invoke("history_read", payload, 512 * 1024);
  }
  function historyDelete(payload: Record<string, unknown>) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.operation !== "string") return invalid();
    if (payload.operation === "delete") {
      if (!exactKeys(payload, ["operation", "id"]) || !idIsValid(payload.id)) return invalid();
    } else if (payload.operation === "clear") {
      if (!exactKeys(payload, ["operation", "type"])) return invalid();
      const type = payload.type;
      if (type !== undefined && typeof type !== "string") return invalid();
      if (type !== undefined && type !== "all" && type !== "text" && type !== "image" && type !== "file") return invalid();
    } else return invalid();
    return invoke("history_delete", payload);
  }
  return { historyRead, historyDelete };
}
