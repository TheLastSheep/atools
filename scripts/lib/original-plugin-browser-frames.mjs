import assert from "node:assert/strict";

/** Non-flattened CDP transport for opaque-origin sandbox OOPIFs. It changes no browser isolation flags. */
export class OriginalFrameSession {
  constructor(parent, sessionId) {
    this.parent = parent; this.sessionId = sessionId; this.nextId = 0;
    this.pending = new Map(); this.handlers = new Map(); this.closed = false;
    parent.on("Target.receivedMessageFromTarget", event => {
      if (event.sessionId !== this.sessionId || this.closed) return;
      const message = JSON.parse(event.message);
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Error(message.error.message)); else pending.resolve(message.result);
      } else for (const handler of this.handlers.get(message.method) || []) handler(message.params);
    });
  }
  on(method, handler) { this.handlers.set(method, [...(this.handlers.get(method) || []), handler]); }
  send(method, params = {}, options = {}) {
    assert.equal(this.closed, false, "Original iframe CDP session already closed");
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Original iframe CDP timeout: " + method)); }, options.timeoutMs || 12000);
      this.pending.set(id, { resolve, reject, timer });
      void this.parent.send("Target.sendMessageToTarget", { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) }, { timeoutMs: options.timeoutMs || 12000 }).catch(error => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }
  invalidate() {
    this.closed = true;
    for (const handler of this.handlers.get("Runtime.executionContextsCleared") || []) handler({});
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Original iframe CDP target detached")); }
    this.pending.clear(); this.handlers.clear();
  }
}
export async function observeOriginalFrameSessions(page, report, onSession, observationSource) {
  const sessions = new Map(), openings = new Set();
  let closing = false;
  const invalidate = () => {
    for (const item of sessions.values()) { item.session.invalidate(); item.record.state = "closed"; }
    sessions.clear();
  };
  const stopAbort = page.onAbort(invalidate);
  report.iframeTargets = [];
  page.on("Target.attachedToTarget", event => {
    if (closing) return;
    const session = new OriginalFrameSession(page, event.sessionId);
    const record = { sessionId: event.sessionId, targetId: event.targetInfo.targetId, type: event.targetInfo.type,
      url: event.targetInfo.url, waitingForDebugger: event.waitingForDebugger, state: "attached" };
    report.iframeTargets.push(record); sessions.set(event.sessionId, { session, record });
    onSession(session, event.sessionId);
    const opening = (async () => {
      try {
        await session.send("Runtime.enable"); await session.send("Page.enable"); await session.send("Network.enable");
        await session.send("Page.addScriptToEvaluateOnNewDocument", { source: observationSource });
        const observed = await session.send("Runtime.evaluate", { expression: observationSource, returnByValue: true });
        assert.ok(!observed.exceptionDetails, observed.exceptionDetails?.text || "Original iframe observer could not be installed");
        record.observerBeforeBusinessInputs = true;
        await session.send("Runtime.runIfWaitingForDebugger"); record.state = "ready";
      } catch (error) {
        record.error = error.message; record.state = closing || session.closed ? "closed" : "setup_failed";
        if (record.state === "setup_failed") report.consoleIssues.push({ kind: "iframe-session", message: error.message });
      }
    })();
    openings.add(opening); void opening.finally(() => openings.delete(opening));
  });
  page.on("Target.detachedFromTarget", ({ sessionId }) => {
    const item = sessions.get(sessionId); if (!item) return;
    item.record.state = "detached"; item.session.invalidate(); sessions.delete(sessionId);
  });
  await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false,
    filter: [{ type: "iframe", exclude: false }, { exclude: true }] });
  return { async close() {
    closing = true; invalidate();
    try {
      await Promise.all([...openings]);
      await page.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: false });
      return { sessions: sessions.size, pendingOpenings: openings.size };
    } finally { invalidate(); stopAbort(); }
  } };
}
