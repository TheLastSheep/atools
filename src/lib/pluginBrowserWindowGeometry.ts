/** Host-confirmed hosted-window geometry. This factory is serialized into plugin documents. */
export function createPluginBrowserWindowGeometry(initial: unknown) {
  type Snapshot = {
    windowId: string; clientCreateId: string; ownerKey: string; instanceNonce: string;
    documentGeneration: number; documentNonce: string; revision: number;
    bounds: { x: number; y: number; width: number; height: number };
    contentBounds?: { x: number; y: number; width: number; height: number };
    boundsSource?: "native";
    minimumSize: [number, number]; maximumSize: [number, number];
  };
  let current: Snapshot | undefined;
  let closed = false;
  function valid(value: unknown): value is Snapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Snapshot;
    if (![item.windowId, item.clientCreateId, item.ownerKey, item.instanceNonce, item.documentNonce].every(v => typeof v === "string" && v.length > 0 && v.length <= 2048)
      || !Number.isSafeInteger(item.documentGeneration) || item.documentGeneration < 1
      || !Number.isSafeInteger(item.revision) || item.revision < 1) return false;
    const b = item.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(v => typeof v === "number" && Number.isFinite(v)) || b.width <= 0 || b.height <= 0) return false;
    if (item.boundsSource !== undefined && item.boundsSource !== "native") return false;
    const content = item.contentBounds;
    if (content !== undefined && (!content || ![content.x, content.y, content.width, content.height]
      .every(v => typeof v === "number" && Number.isFinite(v)) || content.width <= 0 || content.height <= 0)) return false;
    if (item.boundsSource === "native" && content === undefined) return false;
    const min = item.minimumSize, max = item.maximumSize;
    const validConstraints = Array.isArray(min) && min.length === 2 && Array.isArray(max) && max.length === 2
      && [...min, ...max].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
      && (min[0] === 0 || max[0] === 0 || min[0] <= max[0])
      && (min[1] === 0 || max[1] === 0 || min[1] <= max[1]);
    if (!validConstraints) return false;
    return item.boundsSource === "native"
      || ((min[0] === 0 || b.width >= min[0]) && (min[1] === 0 || b.height >= min[1])
        && (max[0] === 0 || b.width <= max[0]) && (max[1] === 0 || b.height <= max[1]));
  }
  function copy(item: Snapshot): Snapshot {
    return { windowId: item.windowId, clientCreateId: item.clientCreateId, ownerKey: item.ownerKey,
      instanceNonce: item.instanceNonce, documentGeneration: item.documentGeneration, documentNonce: item.documentNonce, revision: item.revision,
      bounds: { ...item.bounds }, ...(item.contentBounds ? { contentBounds: { ...item.contentBounds } } : {}),
      ...(item.boundsSource ? { boundsSource: item.boundsSource } : {}),
      minimumSize: [...item.minimumSize], maximumSize: [...item.maximumSize] };
  }
  function apply(value: unknown, initialize = false) {
    if (closed || (!current && !initialize) || !valid(value)) return false;
    if (current && (value.windowId !== current.windowId || value.clientCreateId !== current.clientCreateId
      || value.ownerKey !== current.ownerKey || value.instanceNonce !== current.instanceNonce
      || value.boundsSource !== current.boundsSource
      || value.documentGeneration < current.documentGeneration
      || (value.documentGeneration === current.documentGeneration && value.documentNonce !== current.documentNonce) || value.revision <= current.revision)) return false;
    current = copy(value);
    return true;
  }
  function acceptEvent(value: unknown) {
    if (apply(value)) return true;
    return !closed && !!current && valid(value) && JSON.stringify(copy(value)) === JSON.stringify(current);
  }
  function read(method: string) {
    if (closed) throw Error("ERR_ATOOLS_BROWSER_WINDOW_CLOSED: geometry is closed");
    if (!current) throw Error("ERR_ATOOLS_BROWSER_WINDOW_NOT_READY: geometry has no host-confirmed state");
    const b = current.bounds;
    switch (method) {
      case "getBounds": return { ...b };
      case "getSize": return [b.width, b.height];
      case "getContentSize": {
        const content = current.boundsSource === "native" ? current.contentBounds : b;
        if (!content) throw Error("ERR_ATOOLS_BROWSER_WINDOW_UNSUPPORTED: native content geometry is unavailable");
        return [content.width, content.height];
      }
      case "getPosition": return [b.x, b.y];
      case "getMinimumSize": return [...current.minimumSize];
      case "getMaximumSize": return [...current.maximumSize];
      default: throw Error("ERR_ATOOLS_BROWSER_WINDOW_UNSUPPORTED: geometry getter " + method);
    }
  }
  apply(initial, true);
  return { apply: (value: unknown) => apply(value), acceptEvent, hasState: () => !!current, read, close() { closed = true; current = undefined; }, snapshot: () => current ? copy(current) : undefined };
}
