type FrameRole = { kind: "main" } | { kind: "child"; windowId: string };
export type PluginOpaqueFrameIdentity = FrameRole & { generation: number };
export type PluginDocumentReservation = Readonly<FrameRole & {
  mode: "document";
  generation: number;
  pageDocumentId: string;
  expectedOrigin: string;
  parentOrigin: string;
}>;
export type PluginDocumentIdentity = Readonly<PluginDocumentReservation & { docNonce: string }>;
export type PluginFrameIdentity = PluginOpaqueFrameIdentity | PluginDocumentIdentity;
export type PluginDocumentEnvelope = { pageDocumentId: string; docNonce: string; generation: number };
type Source = object;
export type PluginFrameReplyTarget = {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
};
type Entry = { source: Source; replyTarget?: PluginFrameReplyTarget; identity?: PluginFrameIdentity; reservation?: PluginDocumentReservation;
  invalidated: Set<() => void> };
type Event = { source: unknown; origin?: string; data?: unknown };

export function isPluginDocumentIdentity(identity: PluginFrameIdentity): identity is PluginDocumentIdentity {
  return "mode" in identity && identity.mode === "document";
}
function isSource(value: unknown): value is Source {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function roleMatches(a: FrameRole, b: FrameRole) {
  return a.kind === b.kind && (a.kind === "main" || (b.kind === "child" && a.windowId === b.windowId));
}
function sameIdentity(a: PluginFrameIdentity | undefined, b: PluginFrameIdentity) {
  if (!a || !roleMatches(a, b) || a.generation !== b.generation) return false;
  if (!isPluginDocumentIdentity(a)) return !isPluginDocumentIdentity(b);
  return isPluginDocumentIdentity(b) && a.pageDocumentId === b.pageDocumentId && a.docNonce === b.docNonce
    && a.expectedOrigin === b.expectedOrigin && a.parentOrigin === b.parentOrigin;
}
export function pluginDocumentEnvelope(identity: PluginDocumentIdentity): PluginDocumentEnvelope {
  return { pageDocumentId: identity.pageDocumentId, docNonce: identity.docNonce, generation: identity.generation };
}
export function matchesPluginDocumentEnvelope(value: unknown, identity: PluginDocumentIdentity) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.pageDocumentId === identity.pageDocumentId && data.docNonce === identity.docNonce
    && data.generation === identity.generation;
}
function exactOrigin(value: string) {
  if (!value || value === "null" || value === "*" || !/^[a-z][a-z\d+.-]*:\/\/[^/?#]+$/i.test(value))
    throw Error("ERR_ATOOLS_DOCUMENT_ORIGIN");
  return value;
}

/** A WindowProxy is only a locator. Document entries require an authenticated event. */
export class PluginFrameSourceRegistry {
  private mainSource: Entry | null = null;
  private readonly childSources = new Map<string, Entry>();
  private generation = 0;

  private nextGeneration() {
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw Error("Plugin frame source generation exhausted");
    return ++this.generation;
  }
  private entryForRole(role: FrameRole) {
    return role.kind === "main" ? this.mainSource : this.childSources.get(role.windowId);
  }
  private entryForSource(source: unknown) {
    if (!isSource(source)) return undefined;
    if (this.mainSource?.source === source) return this.mainSource;
    for (const entry of this.childSources.values()) if (entry.source === source) return entry;
    return undefined;
  }
  private drop(role: FrameRole) {
    const entry = this.entryForRole(role);
    if (role.kind === "main") this.mainSource = null;
    else this.childSources.delete(role.windowId);
    if (entry) for (const callback of [...entry.invalidated]) callback();
    entry?.invalidated.clear();
  }
  private put(role: FrameRole, entry: Entry) {
    this.drop(role);
    if (this.mainSource?.source === entry.source) this.drop({ kind: "main" });
    for (const [windowId, existing] of this.childSources)
      if (existing.source === entry.source) this.drop({ kind: "child", windowId });
    if (role.kind === "main") this.mainSource = entry;
    else this.childSources.set(role.windowId, entry);
  }

  setMain(source: unknown) {
    // A legacy load callback cannot downgrade a reserved/active document.
    if (this.mainSource?.reservation) return;
    if (!isSource(source)) { this.drop({ kind: "main" }); return; }
    this.put({ kind: "main" }, { source, identity: { kind: "main", generation: this.nextGeneration() }, invalidated: new Set() });
  }
  unregisterMain(expectedSource?: unknown) {
    if (expectedSource !== undefined && this.mainSource?.source !== expectedSource) return;
    this.drop({ kind: "main" });
  }
  registerChild(windowId: string, source: unknown, replyTarget?: PluginFrameReplyTarget) {
    const id = windowId.trim();
    if (!id || !isSource(source) || this.childSources.get(id)?.reservation) return;
    this.put({ kind: "child", windowId: id }, {
      source, replyTarget, identity: { kind: "child", windowId: id, generation: this.nextGeneration() }, invalidated: new Set(),
    });
  }
  unregisterChild(windowId: string, expectedSource?: unknown) {
    const role = { kind: "child" as const, windowId: windowId.trim() }, entry = this.entryForRole(role);
    if (!entry || (expectedSource !== undefined && entry.source !== expectedSource)) return;
    this.drop(role);
  }

  reserveDocument(options: FrameRole & { source: unknown; pageDocumentId: string; expectedOrigin: string; parentOrigin: string }) {
    if (!isSource(options.source) || !options.pageDocumentId || options.pageDocumentId.length > 128
      || (options.kind === "child" && !options.windowId.trim())) throw Error("ERR_ATOOLS_DOCUMENT_RESERVATION");
    const role: FrameRole = options.kind === "main" ? { kind: "main" } : { kind: "child", windowId: options.windowId };
    const reservation: PluginDocumentReservation = Object.freeze({ ...role, mode: "document", generation: this.nextGeneration(),
      pageDocumentId: options.pageDocumentId, expectedOrigin: exactOrigin(options.expectedOrigin), parentOrigin: exactOrigin(options.parentOrigin) });
    this.put(role, { source: options.source, reservation, invalidated: new Set() });
    return reservation;
  }
  isReserved(reservation: PluginDocumentReservation, source?: unknown) {
    const entry = this.entryForRole(reservation);
    return entry?.reservation === reservation && (source === undefined || entry.source === source);
  }
  activateDocument(reservation: PluginDocumentReservation, docNonce: string): PluginDocumentIdentity | null {
    const entry = this.entryForRole(reservation);
    if (!this.isReserved(reservation) || entry?.identity || typeof docNonce !== "string" || !/^[0-9a-f]{32}$/.test(docNonce)) return null;
    const identity = Object.freeze({ ...reservation, docNonce });
    entry!.identity = identity;
    return identity;
  }
  invalidateDocument(reservation: PluginDocumentReservation) {
    if (!this.isReserved(reservation)) return false;
    this.drop(reservation);
    return true;
  }
  onDocumentInvalidated(reservation: PluginDocumentReservation, callback: () => void) {
    const entry = this.entryForRole(reservation);
    if (!this.isReserved(reservation)) { callback(); return () => undefined; }
    entry!.invalidated.add(callback);
    return () => entry!.invalidated.delete(callback);
  }

  onFrameInvalidated(source: unknown, identity: PluginFrameIdentity, callback: () => void) {
    const entry = this.entryForSource(source);
    if (!entry || !sameIdentity(entry.identity, identity)) { callback(); return () => undefined; }
    entry.invalidated.add(callback);
    return () => entry.invalidated.delete(callback);
  }

  /** Legacy source-only lookups deliberately cannot authorize document entries. */
  identify(source: unknown): PluginFrameIdentity | null {
    const identity = this.entryForSource(source)?.identity;
    return identity && !isPluginDocumentIdentity(identity) ? { ...identity } : null;
  }
  /** Trusted parent lifecycle/pending capture only. Never use to validate an incoming event. */
  currentIdentityForHost(source: unknown): PluginFrameIdentity | null {
    const identity = this.entryForSource(source)?.identity;
    return identity ?? null;
  }
  identifyEvent(event: Event): PluginFrameIdentity | null {
    const identity = this.entryForSource(event.source)?.identity;
    if (!identity) return null;
    if (!isPluginDocumentIdentity(identity)) return { ...identity };
    const data = event.data;
    if (event.origin !== identity.expectedOrigin || !data || typeof data !== "object" || Array.isArray(data)
      || !matchesPluginDocumentEnvelope((data as Record<string, unknown>).__atoolsDocument, identity)) return null;
    return identity;
  }
  isCurrent(source: unknown, identity: PluginFrameIdentity) {
    return sameIdentity(this.entryForSource(source)?.identity, identity);
  }
  reply(source: unknown, identity: PluginFrameIdentity, message: unknown) {
    if (!this.isCurrent(source, identity)) return false;
    const entry = this.entryForSource(source);
    const target = entry?.replyTarget ?? source as { postMessage?: (data: unknown, targetOrigin: string, transfer?: Transferable[]) => void };
    if (typeof target.postMessage !== "function") return false;
    if (isPluginDocumentIdentity(identity) && (!message || typeof message !== "object" || Array.isArray(message))) return false;
    const data = isPluginDocumentIdentity(identity)
      ? { ...(message as Record<string, unknown>), __atoolsDocument: pluginDocumentEnvelope(identity) } : message;
    try { target.postMessage(data, isPluginDocumentIdentity(identity) ? identity.expectedOrigin : "*"); return true; }
    catch { return false; }
  }
  clear() {
    this.drop({ kind: "main" });
    for (const windowId of [...this.childSources.keys()]) this.drop({ kind: "child", windowId });
  }
}

export function identifyPluginMessageEvent(sources: PluginFrameSourceRegistry, event: Event) {
  return sources.identifyEvent(event);
}
export async function runPluginFrameOperation<T>(options: {
  source: unknown; identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry; operation: () => Promise<T>;
}) {
  const assertCurrent = () => {
    if (!options.sources.isCurrent(options.source, options.identity)) throw Error("Plugin message source is no longer active");
  };
  assertCurrent();
  try { const result = await options.operation(); assertCurrent(); return result; }
  catch (error) { assertCurrent(); throw error; }
}
export function postPluginFrameMessageIfCurrent(options: {
  source: unknown; identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry; message: unknown;
  /** Retained for source compatibility; callers cannot override the registry's destination. */
  targetOrigin?: string;
}) {
  return options.sources.reply(options.source, options.identity, options.message);
}
