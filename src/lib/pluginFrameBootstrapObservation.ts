export type PluginFrameBootstrapObservation = Readonly<{
  phase: "awaiting-hello" | "offered" | "claiming" | "delivered" | "ready" | "closed";
  bootstrapLoad: boolean;
  payloadLoad: boolean;
  ackReceived: boolean;
}>;

type BootstrapReader = () => unknown;
type ObservationEntry = Readonly<{ source: Window; frameSrc: string; pageDocumentId: string; read: BootstrapReader }>;
const observations = new WeakMap<HTMLIFrameElement, ObservationEntry>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPhase(value: unknown): value is PluginFrameBootstrapObservation["phase"] {
  return value === "awaiting-hello" || value === "offered" || value === "claiming"
    || value === "delivered" || value === "ready" || value === "closed";
}

/** Registers only the real mounted frame and lets its exact owner revoke the weak entry. */
export function registerPluginFrameBootstrapObservation(
  frame: HTMLIFrameElement,
  source: Window,
  pageDocumentId: string,
  read: BootstrapReader,
): () => void {
  const frameSrc = frame.getAttribute("src");
  if (!frame.isConnected || frame.contentWindow !== source || !frameSrc || !UUID.test(pageDocumentId)) return () => {};
  const entry = { source, frameSrc, pageDocumentId: pageDocumentId.toLowerCase(), read };
  observations.set(frame, entry);
  return () => {
    if (observations.get(frame) === entry) observations.delete(frame);
  };
}

/** Reads a fixed projection only while the same frame, source and page identity remain current. */
export function readPluginFrameBootstrapObservation(
  frame: HTMLIFrameElement,
  source: Window,
  pageDocumentId: string,
): PluginFrameBootstrapObservation | null {
  const entry = observations.get(frame);
  if (!entry || !frame.isConnected || frame.contentWindow !== source || entry.source !== source
    || frame.getAttribute("src") !== entry.frameSrc
    || entry.pageDocumentId !== pageDocumentId.toLowerCase()) return null;
  let raw: unknown;
  try { raw = entry.read(); } catch { return null; }
  if (!isRecord(raw) || !isPhase(raw.phase)
    || typeof raw.bootstrapLoad !== "boolean" || typeof raw.payloadLoad !== "boolean"
    || typeof raw.ackReceived !== "boolean") return null;
  return { phase: raw.phase, bootstrapLoad: raw.bootstrapLoad,
    payloadLoad: raw.payloadLoad, ackReceived: raw.ackReceived };
}
