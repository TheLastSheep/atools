export type ImageToolboxMessageTarget = Pick<Window, "addEventListener" | "removeEventListener">;
export type ImageToolboxReportListener = (summary: unknown) => void;

export type NativeImageToolboxGeometry = {
  canvas: { width: number | null; height: number | null; zoom: number | null };
  container: { left: number | null; top: number | null; right: number | null; bottom: number | null; width: number | null; height: number | null };
  child: { innerWidth: number | null; innerHeight: number | null; devicePixelRatio: number | null };
};

export function parseNativeImageToolboxGeometry(value: unknown): { geometry: NativeImageToolboxGeometry; valid: boolean } {
  const object = (item: unknown): Record<string, unknown> | null =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
  const bounded = (item: unknown, min: number, max: number): number | null =>
    typeof item === "number" && Number.isFinite(item) && item >= min && item <= max ? item : null;
  const root = object(value), canvas = object(root?.canvas), container = object(root?.container), child = object(root?.child);
  const expected = (record: Record<string, unknown> | null, keys: string[]) =>
    record !== null && Object.keys(record).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
  const geometry: NativeImageToolboxGeometry = {
    canvas: {
      width: bounded(canvas?.width, 1, 8192), height: bounded(canvas?.height, 1, 8192), zoom: bounded(canvas?.zoom, 0.01, 100),
    },
    container: {
      left: bounded(container?.left, -1_000_000, 1_000_000), top: bounded(container?.top, -1_000_000, 1_000_000),
      right: bounded(container?.right, -1_000_000, 1_000_000), bottom: bounded(container?.bottom, -1_000_000, 1_000_000),
      width: bounded(container?.width, 1, 32768), height: bounded(container?.height, 1, 32768),
    },
    child: {
      innerWidth: bounded(child?.innerWidth, 1, 32768), innerHeight: bounded(child?.innerHeight, 1, 32768),
      devicePixelRatio: bounded(child?.devicePixelRatio, 0.1, 16),
    },
  };
  const valid = expected(root, ["canvas", "container", "child"])
    && expected(canvas, ["width", "height", "zoom"])
    && expected(container, ["left", "top", "right", "bottom", "width", "height"])
    && expected(child, ["innerWidth", "innerHeight", "devicePixelRatio"])
    && Object.values(geometry.canvas).every(item => item !== null)
    && Object.values(geometry.container).every(item => item !== null)
    && Object.values(geometry.child).every(item => item !== null);
  return { geometry, valid };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keeps listening through unrelated plugin bridge messages; caller disposes on send/timeout. */
export function listenForImageToolboxReport(
  target: ImageToolboxMessageTarget,
  pluginSource: () => MessageEventSource | null,
  onReport: ImageToolboxReportListener,
): () => void {
  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    target.removeEventListener("message", receive);
  };
  const receive = (event: Event) => {
    if (!active) return;
    const message = event as MessageEvent<unknown>;
    if (message.source === null || message.source !== pluginSource() || message.origin !== "null") return;
    if (!record(message.data) || message.data.kind !== "atools-image-toolbox-smoke") return;
    dispose();
    onReport(message.data.summary);
  };
  target.addEventListener("message", receive);
  return dispose;
}
