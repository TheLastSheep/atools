import { describe, expect, it } from "vitest";
import { productionHostedIpcFixture } from "./pluginHostedIpcProductionFixture";

async function eventually(assertion: () => void, steps = 30) {
  let last: unknown;
  for (let step = 0; step < steps; step++) {
    try { assertion(); return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw last;
}

describe("Actual child load wiring joins window control and MessagePort readiness", () => {
  it.each(["open-before-rpc", "rpc-before-open"])("waits for both current document proofs: %s", async order => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(), child = await h.frame("child", main, false, undefined, order === "rpc-before-open", true);
      child.evaluate("window.messages=[];window.require('electron').ipcRenderer.on('roundtrip',function(e,n){window.messages.push([e.senderId,n]);});");
      child.childWiring!.load();
      await eventually(() => expect(h.rpc.isReady("child")).toBe(true));
      if (order === "rpc-before-open") {
        await h.settle();
        expect(h.deliveries.some(d => d.message.__atools_browser_window_ready__)).toBe(false);
        expect(h.router.pendingReadyCount()).toBe(1);
        child.flushLifecycle();
      }
      await eventually(() => expect(h.deliveries.some(d => d.message.__atools_browser_window_ready__)).toBe(true));
      main.window.require("electron").ipcRenderer.sendTo(child.id, "roundtrip", "delivered");
      await eventually(() => expect(child.window.messages).toEqual([[main.id, "delivered"]]));
      expect(h.router.stats().pending).toBe(0);
      expect(h.router.pendingReadyCount()).toBe(0);
      expect(h.deliveries.some(d => d.message.__atools_browser_window_failed__)).toBe(false);
      // A late open belongs to the already observed load, so it cannot authorize another bare load.
      child.childWiring!.load();
      expect(() => h.router.captureDocumentLease({ source: child.source, identity: h.sources.currentIdentityForHost(child.source)! }, child.posted[0].documentNonce)).toThrow();
      child.childWiring!.destroy();
    } finally { h.closeRpc(); h.router.clear(); }
  });

  it("cancels a pending runtime confirmation when the real child action is destroyed", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(), child = await h.frame("child", main, false, undefined, true, true);
      child.childWiring!.load();
      await eventually(() => expect(h.rpc.isReady("child")).toBe(true));
      await eventually(() => expect(h.router.pendingReadyCount()).toBe(1));
      child.childWiring!.destroy();
      await h.settle();
      expect(h.deliveries.some(d => d.message.__atools_browser_window_ready__)).toBe(false);
      expect(h.rpc.isAttached("child")).toBe(false);
      expect(h.router.stats().pending).toBe(0);
      expect(h.router.pendingReadyCount()).toBe(0);
    } finally { h.closeRpc(); h.router.clear(); }
  });

  it("rejects missing or stale RPC document proofs without making a new runtime ready", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(), child = await h.frame("child", main, false);
      await expect(h.router.confirmReady(child.role, child.source, undefined)).rejects.toThrow("runtime document nonce");
      await expect(h.router.confirmReady(child.role, child.source, "0".repeat(32))).rejects.toThrow("does not match");
      expect(child.posted[0].documentNonce).not.toBe("0".repeat(32));
      const stale = child.posted[0].documentNonce;
      const replacement = await h.frame("child", main, false, child);
      await expect(h.router.confirmReady(replacement.role, replacement.source, stale)).rejects.toThrow("does not match");
      expect(h.router.stats().pending).toBe(0);
    } finally { h.closeRpc(); h.router.clear(); }
  });

  it.each([false, true])("makes the public ready handle usable for webContents.send and sendTo after both proofs (lateOpen=%s)", async lateOpen => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(); h.setRealChildCreates({ holdLifecycle: lateOpen });
      main.evaluate("window.child=window.utools.createBrowserWindow('child.html');window.resolved=false;window.child.ready.then(function(){window.resolved=true;});");
      await eventually(() => expect(h.frames.length).toBe(2));
      const child = h.frames[1];
      await eventually(() => expect(h.rpc.isReady(child.windowId)).toBe(true));
      if (lateOpen) {
        await h.settle(); expect(main.window.resolved).toBe(false);
        child.flushLifecycle();
      }
      await eventually(() => expect(main.window.resolved).toBe(true));
      expect(main.window.child.webContents.id).toBe(child.window.utools.getWebContentsId());
      child.evaluate("window.messages=[];window.require('electron').ipcRenderer.on('owned',function(e,n){window.messages.push([e.senderId,n]);});");
      await main.window.child.webContents.send("owned", "webContents");
      main.window.require("electron").ipcRenderer.sendTo(child.id, "owned", "sendTo");
      await eventually(() => expect(child.window.messages).toEqual([[main.id, "webContents"], [main.id, "sendTo"]]));
      child.childWiring.destroy();
      expect(h.router.pendingReadyCount()).toBe(0);
    } finally { h.closeRpc(); h.router.clear(); }
  });

  it("does not announce or invalidate a replacement runtime when an old RPC confirmation is pending", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(), child = await h.frame("child", main, false, undefined, true, true);
      child.childWiring!.load();
      await eventually(() => expect(h.router.pendingReadyCount()).toBe(1));
      const replacement = await h.frame("child", main, false, child);
      await h.settle();
      expect(h.deliveries.some(d => d.message.__atools_browser_window_ready__ || d.message.__atools_browser_window_failed__)).toBe(false);
      expect(() => h.router.captureDocumentLease(replacement, replacement.posted[0].documentNonce)).not.toThrow();
      expect(h.router.pendingReadyCount()).toBe(0);
      child.childWiring!.destroy();
    } finally { h.closeRpc(); h.router.clear(); }
  });
  it("times out only an active unmatched confirmation and drains its bounded timer", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(), child = await h.frame("child", main, false, undefined, true, true);
      expect(h.router.pendingReadyCount()).toBe(0);
      child.childWiring!.load();
      await eventually(() => expect(h.router.pendingReadyCount()).toBe(1));
      await eventually(() => expect(h.deliveries.some(d => d.message.__atools_browser_window_failed__)).toBe(true), 90);
      expect(h.deliveries.some(d => d.message.__atools_browser_window_ready__)).toBe(false);
      expect(h.router.pendingReadyCount()).toBe(0);
      child.childWiring!.destroy();
    } finally { h.closeRpc(); h.router.clear(); }
  });
  it("confirms a new runtime on a reused iframe action without repeating the initial creator-ready notification", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const main = await h.frame(), child = await h.frame("child", main, false, undefined, false, true);
      child.childWiring!.load();
      await eventually(() => expect(h.deliveries.filter(d => d.message.__atools_browser_window_ready__)).toHaveLength(1));
      const replacement = await h.frame("child", main, false, child);
      replacement.evaluate("window.messages=[];window.require('electron').ipcRenderer.on('current',function(e,n){window.messages.push(n);});");
      child.childWiring!.load();
      await eventually(() => expect(h.rpc.isReady("child")).toBe(true));
      main.window.require("electron").ipcRenderer.sendTo(replacement.id, "current", "after-self-reload");
      await eventually(() => expect(replacement.window.messages).toEqual(["after-self-reload"]));
      expect(h.deliveries.filter(d => d.message.__atools_browser_window_ready__)).toHaveLength(1);
      expect(h.router.pendingReadyCount()).toBe(0);
      child.childWiring!.destroy();
    } finally { h.closeRpc(); h.router.clear(); }
  });
});
