// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { menuClickChannel, menuClickMarker, originalMenuLifecycleFixture, waitFor } from "./pluginHostedMenuLifecycleFixture";

function observe(promise: Promise<any>) {
  return promise.then(value => ({ status: "fulfilled" as const, value }),
    error => ({ status: "rejected" as const, error }));
}
const observations: unknown[] = [];
afterAll(async () => {
  if (process.env.ATOOLS_MENU_RACE_REPORT_PATH) {
    await writeFile(process.env.ATOOLS_MENU_RACE_REPORT_PATH, JSON.stringify({ observations }, null, 2) + "\n");
  }
});

describe("Original ContextMenu lifecycle across independent production channels", () => {
  it("confirms the actual child after a separately held lifecycle queue exceeds the fast RPC-test allowance", async () => {
    const f = await originalMenuLifecycleFixture({ holdLifecycle: true });
    try {
      const handle = f.startOriginal();
      await waitFor(() => f.h.frames.length === 2, "Child creation missing");
      await new Promise(resolve => setTimeout(resolve, 200));
      const child = await f.prepareChild();
      f.releaseReady(); f.releaseCreate(); await handle.ready;
      expect(handle.webContents.id).toBe(child.id);
      expect(f.h.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("still rejects confirmation when an explicitly short document deadline really expires", async () => {
    const f = await originalMenuLifecycleFixture({ holdLifecycle: true, documentTimeoutMs: 20 });
    try {
      observe(f.startOriginal().ready);
      await waitFor(() => f.h.frames.length === 2, "Child creation missing");
      await waitFor(() => f.h.router.pendingReadyCount() > 0, "Actual document confirmation did not start");
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(f.h.router.pendingReadyCount()).toBe(0);
      await expect(f.prepareChild()).rejects.toThrow("invalid document handshake");
    } finally { await f.close(); }
  });

  it.each([false, true])("queues an early creator-ready notification until the response binds the real ID (lateOpen=%s)", async lateOpen => {
    const f = await originalMenuLifecycleFixture({ holdLifecycle: lateOpen });
    try {
      const handle = f.startOriginal(), child = await f.prepareChild();
      f.releaseReady(); await f.h.settle();
      expect(handle.webContents.id).toBeUndefined();
      expect(child.evaluate("indexPageId")).toBeNull();
      f.releaseCreate(); await handle.ready;
      await waitFor(() => child.evaluate("indexPageId") === f.main.id, "Original ready callback handshake missing");
      expect(handle.webContents.id).toBe(child.id);
      expect(f.h.errors).toEqual([]); expect(f.domErrors).toEqual([]);
      observations.push({ scenario: "ready-before-create-response", lateOpen, callbackHandshake: true, realChildId: true });
    } finally { await f.close(); }
  });

  it("runs the original ready callback after create response then readiness, with the same actual child ID", async () => {
    const f = await originalMenuLifecycleFixture();
    try {
      const handle = f.startOriginal(), child = await f.prepareChild();
      f.releaseCreate(); await f.h.settle();
      expect(handle.webContents.id).toBe(child.id);
      expect(child.evaluate("indexPageId")).toBeNull();
      f.releaseReady(); await handle.ready;
      await waitFor(() => child.evaluate("indexPageId") === f.main.id, "Original ready callback handshake missing");
      expect(f.h.errors).toEqual([]); expect(f.domErrors).toEqual([]);
      observations.push({ scenario: "create-response-before-ready", callbackHandshake: true, realChildId: true });
    } finally { await f.close(); }
  });

  it.each(["old", "current"] as const)("%s fixture completes when click RPC response wins the close race", async version => {
    const f = await originalMenuLifecycleFixture({ holdMenuDelivery: true });
    try {
      const { result } = await f.startFixture(version), outcome = observe(result);
      await f.prepareChild(); f.releaseCreate(); f.releaseReady();
      await Promise.race([waitFor(() => f.heldMenu() === 1, "Original click did not send its menu operation"),
        outcome.then(value => { if (value.status === "rejected") throw value.error; })]);
      // Require the actual RpcHost result to reach the native response before
      // delivering the close trigger from the independent window queue.
      await waitFor(() => f.trace.some(item => item.event === (version === "old" ? "click-native-result" : "arm-native-result")), "Real RPC result missing");
      f.releaseMenu();
      const completed = await outcome;
      expect(completed.status).toBe("fulfilled");
      if (completed.status === "fulfilled") {
        expect(completed.value.originalToggleCalls).toEqual([false]);
        expect(completed.value.classClearedHandle).toBe(true);
        expect(completed.value.actualChildDestroyed).toBe(true);
        expect(completed.value.handshakeParentMatches).toBe(true);
      }
      expect(f.h.router.stats().pending).toBe(0); expect(f.domErrors).toEqual([]);
      observations.push({ scenario: "response-before-close", version, outcome: completed.status, toggles: [...f.toggles], trace: [...f.trace] });
    } finally { await f.close(); }
  });

  it.each(["old", "current"] as const)("%s fixture preserves its observed outcome when close wins the independent queue", async version => {
    const f = await originalMenuLifecycleFixture({ holdClickResponse: true });
    try {
      const { result } = await f.startFixture(version), outcome = observe(result);
      await f.prepareChild(); f.releaseCreate(); f.releaseReady();
      await Promise.race([waitFor(() => f.toggles.length === 1 && (version === "current" || f.heldResponses() === 1), "Original action or pending RPC response missing"),
        outcome.then(value => { if (value.status === "rejected" && f.toggles.length === 0) throw value.error; })]);
      await waitFor(() => !f.h.rpc.isAttached(f.child().windowId), "Production close did not invalidate RpcHost");
      const completed = await outcome;
      expect(completed.status).toBe(version === "old" ? "rejected" : "fulfilled");
      if (completed.status === "rejected") expect(f.clickError()).toContain("Hosted BrowserWindow RPC child-1 closed");
      if (version === "current") { expect(f.heldResponses()).toBe(0); expect(f.clickRpcRequests()).toBe(0); }
      expect(f.toggles).toEqual([false]);
      expect(f.main.window.__atoolsOriginalMenu.contextmenuWindow).toBeNull();
      expect(f.h.sources.currentIdentityForHost(f.child().source)).toBeNull();
      expect(f.h.router.stats().pending).toBe(0);
      f.releaseResponses(); await new Promise(resolve => setImmediate(resolve));
      expect(f.h.rpc.isAttached(f.child().windowId)).toBe(false);
      expect(f.toggles).toEqual([false]); expect(f.domErrors).toEqual([]);
      observations.push({ scenario: "close-before-response", version, outcome: completed.status, toggles: [...f.toggles],
        fixtureDiagnostic: completed.status === "rejected" ? completed.error.fixtureDiagnostic : undefined,
        rpcError: completed.status === "rejected" ? completed.error.message : undefined, nativeRpcError: f.clickError(), trace: [...f.trace],
        childRegistered: !!f.h.sources.currentIdentityForHost(f.child().source), rpcAttached: f.h.rpc.isAttached(f.child().windowId) });
    } finally { await f.close(); }
  });

  it("does not equate a successful click RPC with a completed menu action while business delivery is held", async () => {
    const f = await originalMenuLifecycleFixture({ holdMenuDelivery: true });
    try {
      const handle = f.startOriginal(), child = await f.prepareChild(); f.releaseCreate(); f.releaseReady(); await handle.ready;
      await waitFor(() => child.evaluate("indexPageId") === f.main.id, "Handshake missing");
      await expect(handle.webContents.executeJavaScript("document.getElementById('hidePile').click();true")).resolves.toBe(true);
      expect(f.heldMenu()).toBe(1); expect(f.toggles).toEqual([]);
      expect(handle.isDestroyed()).toBe(false); expect(f.h.rpc.isAttached(child.windowId)).toBe(true);
      f.releaseMenu(); await waitFor(() => handle.isDestroyed(), "Original close missing");
      expect(f.toggles).toEqual([false]);
      observations.push({ scenario: "click-result-with-business-delivery-held", rpcResult: true, noPrematureBusinessSuccess: true });
    } finally { await f.close(); }
  });

  it("keeps genuine evaluation errors observable without inventing a successful menu action", async () => {
    const f = await originalMenuLifecycleFixture();
    try {
      const handle = f.startOriginal(), child = await f.prepareChild(); f.releaseCreate(); f.releaseReady(); await handle.ready;
      await expect(handle.webContents.executeJavaScript("throw new Error('controlled evaluation failure')")).rejects.toThrow("controlled evaluation failure");
      expect(f.toggles).toEqual([]); expect(handle.isDestroyed()).toBe(false);
      expect(f.h.rpc.isAttached(child.windowId)).toBe(true); expect(f.h.router.stats().pending).toBe(0);
      observations.push({ scenario: "evaluation-error", errorObservable: true, noBusinessSideEffect: true, childRemainsOpen: true });
    } finally { await f.close(); }
  });

  it("requires the arming RPC ACK and propagates a genuine arming error before any trigger", async () => {
    const f = await originalMenuLifecycleFixture();
    try {
      const { result } = await f.startFixture("current"), outcome = observe(result);
      await f.prepareChild(); f.failArming(); f.releaseCreate(); f.releaseReady();
      const completed = await outcome;
      expect(completed.status).toBe("rejected");
      if (completed.status === "rejected") expect(completed.error.fixtureDiagnostic).toEqual({
        step: "dom-click-arm", errorClass: "Error", knownErrorCode: "ORIGINAL_MENU_DOM_CLICK_ARM_FAILED" });
      expect(f.trace.some(item => item.event === "fixture-trigger-sent")).toBe(false);
      expect(f.toggles).toEqual([]); expect(f.h.rpc.isAttached(f.child().windowId)).toBe(true);
      observations.push({ scenario: "arming-error", triggerNotSent: true, noBusinessSideEffect: true });
    } finally { await f.close(); }
  });

  it.each(["missing", "wrong-marker", "wrong-sender"] as const)("fails strictly when the trigger is %s", async triggerMode => {
    const f = await originalMenuLifecycleFixture({ triggerMode });
    try {
      const { result } = await f.startFixture("current"), outcome = observe(result);
      await f.prepareChild(); f.releaseCreate(); f.releaseReady();
      await waitFor(() => f.trace.some(item => item.event === "fixture-trigger-sent"), "Trigger was not attempted");
      const previousPauses = f.waitPauses();
      await waitFor(() => f.waitPauses() > previousPauses, "Fixture close observation did not wait");
      f.expireFixtureWait();
      const completed = await outcome;
      expect(completed.status).toBe("rejected");
      if (completed.status === "rejected") expect(completed.error.fixtureDiagnostic).toEqual({
        step: "close", errorClass: "Error", knownErrorCode: "ORIGINAL_MENU_CLOSE_UNCONFIRMED" });
      expect(f.toggles).toEqual([]); expect(f.h.rpc.isAttached(f.child().windowId)).toBe(true);
      if (triggerMode !== "missing") {
        f.main.window.require("electron").ipcRenderer.sendTo(f.child().id, menuClickChannel, menuClickMarker);
        await f.h.settle(); expect(f.toggles).toEqual([]);
      }
      observations.push({ scenario: "invalid-trigger", triggerMode, rejected: true, noBusinessSideEffect: true });
    } finally { await f.close(); }
  });

  it("consumes the fixed trigger once and cannot replay the original click before close", async () => {
    const f = await originalMenuLifecycleFixture({ holdMenuDelivery: true });
    try {
      const { result } = await f.startFixture("current"), outcome = observe(result);
      await f.prepareChild(); f.releaseCreate(); f.releaseReady();
      await waitFor(() => f.heldMenu() === 1, "Original menu action was not queued");
      f.main.window.require("electron").ipcRenderer.sendTo(f.child().id, menuClickChannel, menuClickMarker);
      await f.h.settle(); expect(f.heldMenu()).toBe(1); expect(f.toggles).toEqual([]);
      f.releaseMenu(); const completed = await outcome;
      expect(completed.status).toBe("fulfilled"); expect(f.toggles).toEqual([false]);
      expect(f.clickRpcRequests()).toBe(0);
      observations.push({ scenario: "once-trigger", duplicateIgnoredBeforeClose: true, originalToggleExactlyOnce: true });
    } finally { await f.close(); }
  });
});
