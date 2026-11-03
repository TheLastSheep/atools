import assert from "node:assert/strict";

/** Adds cancellable budgets to the real CdpClient pending map; no timeout Promise.race. */
export function boundedOriginalCdp(raw, { totalMs = 120000, commandMs = 10000, closeMs = 1500, now = Date.now } = {}) {
  let deadline = now() + totalMs, timer, stopped = false, expired = false, phase = "business";
  const aborters = new Set(), eventWaits = new Set();
  const state = { totalMs, commandMs, cleanupMs: null, timedOutCommands: [], totalDeadlineExceeded: false, pendingAtClose: null };
  function cancel(error) {
    for (const pending of raw.pending.values()) pending.reject(error);
    raw.pending.clear();
    for (const stop of [...eventWaits]) stop(error);
    for (const abort of [...aborters]) abort(error);
  }
  function expire() {
    expired = true; state.totalDeadlineExceeded = true;
    cancel(Error(`Original browser ${phase} total deadline exceeded`));
  }
  function arm() { clearTimeout(timer); timer = setTimeout(expire, Math.max(1, deadline - now())); }
  function remaining() {
    assert.equal(stopped, false, "Original browser CDP transport closed");
    if (expired || deadline <= now()) { if (!expired) expire(); throw Error(`Original browser ${phase} total deadline exceeded`); }
    return deadline - now();
  }
  function removeEvent(method, handler) {
    raw.eventHandlers.set(method, (raw.eventHandlers.get(method) || []).filter(item => item !== handler));
  }
  const page = {
    state, on: raw.on.bind(raw), remaining,
    onAbort(abort) { aborters.add(abort); return () => aborters.delete(abort); },
    async send(method, params = {}, options = {}) {
      const timeoutMs = Math.max(1, Math.min(remaining(), commandMs, options.timeoutMs > 0 ? options.timeoutMs : commandMs));
      try { return await raw.send(method, params, { ...options, timeoutMs }); }
      catch (error) { if (/Timed out/.test(error.message)) state.timedOutCommands.push({ method, timeoutMs, phase }); throw error; }
    },
    waitForEvent(method, requestedMs = commandMs) {
      return new Promise((resolve, reject) => {
        let waitTimer;
        const finish = (error, value) => { clearTimeout(waitTimer); removeEvent(method, handler); eventWaits.delete(stop); if (error) reject(error); else resolve(value); };
        const handler = value => finish(null, value), stop = error => finish(error);
        waitTimer = setTimeout(() => finish(Error("Original browser event deadline: " + method)), Math.min(remaining(), commandMs, requestedMs));
        eventWaits.add(stop); raw.on(method, handler);
      });
    },
    beginCleanup({ totalMs: budget = 8000, commandMs: commandBudget = 1200 } = {}) {
      cancel(Error("Original browser business phase finished"));
      phase = "cleanup"; expired = false; commandMs = commandBudget; deadline = now() + budget; state.cleanupMs = budget; arm();
    },
    async close() {
      if (stopped) return state;
      stopped = true; clearTimeout(timer); cancel(Error("Original browser CDP transport closing"));
      const socket = raw.ws.socket;
      assert.ok(socket, "Owned CDP TCP socket is required for cancellable close");
      await new Promise((resolve, reject) => {
        if (socket.destroyed) { resolve(); return; }
        const onClose = () => finish(), onError = error => finish(error);
        const finish = error => { clearTimeout(closeTimer); socket.off("close", onClose); socket.off("error", onError); if (error) reject(error); else resolve(); };
        const closeTimer = setTimeout(() => { state.socketCloseForced = true; socket.destroy(); }, closeMs);
        socket.once("close", onClose); socket.once("error", onError); socket.end();
      });
      state.socketDestroyed = socket.destroyed; state.pendingAtClose = raw.pending.size;
      state.eventWaitsAtClose = eventWaits.size; state.deadlineTimerCleared = true;
      aborters.clear(); raw.eventHandlers.clear(); return state;
    },
  };
  raw.ws.socket.on("close", () => cancel(Error("Original DevTools socket closed")));
  arm(); return page;
}

/** The local /json/new HTTP transaction is aborted and drained on its deadline. */
export async function createOriginalPageTarget(browserUrl, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const parsed = new URL(browserUrl), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error("Original DevTools target creation deadline exceeded")), timeoutMs);
  try {
    const endpoint = `http://${parsed.hostname}:${parsed.port}/json/new?about:blank`;
    let response = await fetchImpl(endpoint, { method: "PUT", signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); response = await fetchImpl(endpoint, { signal: controller.signal }); }
    assert.equal(response.ok, true, "Owned Chrome target creation failed");
    const target = await response.json(); assert.ok(target.webSocketDebuggerUrl, "Owned target missing websocket URL"); return target.webSocketDebuggerUrl;
  } finally { clearTimeout(timer); }
}

/** Consume navigation and its event together, including simultaneous deadline rejection. */
export async function navigateOriginalPage(page, url) {
  const loaded = page.waitForEvent("Page.domContentEventFired", 15000);
  await Promise.all([page.send("Page.navigate", { url }), loaded]);
}
