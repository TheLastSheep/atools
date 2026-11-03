type Unlisten = () => void;
export type PluginPageRevocationListener = (event: string, receive: (event: { payload: unknown }) => void) => Promise<Unlisten>;

/** One native listener per prepared page; closing also drains a late registration. */
export function createPluginPageRevocationSubscription(options: {
  pageDocumentId: string; listen: PluginPageRevocationListener; onRevoked: () => void;
}) {
  let active = true, unlisten: Unlisten | undefined;
  const ready = options.listen("plugin-page-revoked", event => {
    if (!active || !event.payload || typeof event.payload !== "object") return;
    const value = event.payload as Record<string, unknown>;
    if (value.pageDocumentId !== options.pageDocumentId || value.reason !== "navigation") return;
    active = false; unlisten?.(); unlisten = undefined;
    options.onRevoked();
  }).then(stop => { if (active) unlisten = stop; else stop(); });
  void ready.catch(() => undefined);
  function close() { active = false; unlisten?.(); unlisten = undefined; }
  return { ready, close };
}
