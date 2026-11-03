import { describe, expect, it, vi } from "vitest";
import { productionHostedIpcFixture } from "./pluginHostedIpcProductionFixture";

describe("Serialized production broker, Electron adapter and native IPC entry", () => {
  it("provides synchronous IDs and a created child webContents ID that matches its own document", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame();
    expect(main.window.utools.getWebContentsId()).toBe(main.id);
    main.evaluate("window.child=window.utools.createBrowserWindow('child.html');");
    await new Promise(resolve => setTimeout(resolve, 10));
    await h.settle();
    const child = h.frames[1];
    expect(child).toBeDefined();
    expect(main.window.child.webContents.id).toBe(child.window.utools.getWebContentsId());
    expect(main.window.child.webContents.id).not.toBe(main.id);
    await expect(main.window.child.ready).resolves.toBe(main.window.child);
    child.evaluate("window.received=[];window.require('electron').ipcRenderer.once('owned',function(e,n){window.received.push([e.senderId,n]);});");
    await main.window.child.webContents.send("owned", "value"); await h.settle();
    expect(child.window.received).toEqual([[main.id, "value"]]);
  });

  it("routes through both raw and final Electron brokers and authenticates senderId independently of payload", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), a = await h.frame("a", main), b = await h.frame("b", main), nested = await h.frame("nested", a);
    for (const target of [main, a, b, nested]) target.evaluate("window.messages=[];window.require('electron').ipcRenderer.on('route',function(event,value){window.messages.push({senderId:event.senderId,value:value});});");
    expect(main.rawElectron.ipcRenderer.sendTo(a.id, "route", "raw")).toBeUndefined();
    a.evaluate(`window.require('electron').ipcRenderer.sendTo(${b.id},'route',{senderId:999});`);
    nested.evaluate(`window.require('electron').ipcRenderer.sendTo(${main.id},'route','nested');`);
    b.evaluate(`window.require('electron').ipcRenderer.sendTo(${nested.id},'route','sibling-nested');`);
    await h.settle();
    expect(a.window.messages).toEqual([{ senderId: main.id, value: "raw" }]);
    expect(b.window.messages).toEqual([{ senderId: a.id, value: { senderId: 999 } }]);
    expect(main.window.messages).toEqual([{ senderId: nested.id, value: "nested" }]);
    expect(nested.window.messages).toEqual([{ senderId: b.id, value: "sibling-nested" }]);
    expect(h.router.stats().pending).toBe(0);
  });

  it("preserves once, off, removeAllListeners and ignores packets from another WindowProxy", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main);
    child.evaluate(`window.values=[];var ipc=window.require('electron').ipcRenderer;
      var removed=function(){window.values.push('removed');};
      ipc.on('event',removed).off('event',removed);ipc.once('event',function(e,n){window.values.push(n);});`);
    for (const n of [1, 2]) main.window.require("electron").ipcRenderer.sendTo(child.id, "event", n);
    await h.settle();
    expect(child.window.values).toEqual([1]);
    child.evaluate("ipc.on('event',function(){window.values.push('all');}).removeAllListeners('event');");
    main.window.require("electron").ipcRenderer.sendTo(child.id, "event", 3); await h.settle();
    expect(child.window.values).toEqual([1]);
    child.host({ __atools_hosted_ipc__: true, senderId: main.id, channel: "event", args: [4] }, {});
    expect(child.window.values).toEqual([1]);
  });

  it("uses the real host permission wait, observes denial once and never replays after a later grant", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main);
    let reject!: (error: Error) => void;
    const gate = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; })); h.setPermission(gate);
    expect(main.window.require("electron").ipcRenderer.sendTo(child.id, "route", "denied")).toBeUndefined();
    expect(gate).toHaveBeenCalledWith("browserWindow");
    expect(h.router.stats().pending).toBe(1);
    reject(new Error("Permission denied")); await h.settle();
    expect(h.errors).toHaveLength(1); expect(h.deliveries.filter(d => d.message.__atools_hosted_ipc__)).toHaveLength(0);
    h.setPermission(async () => {}); await h.settle();
    expect(h.receivedNative.filter(d => d.method === "sendTo")).toHaveLength(1);
    expect(h.router.stats().pending).toBe(0);
  });

  it.each(["sender", "target"])("captures the %s generation before permission is granted and rejects reload", async side => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main);
    let allow!: () => void; h.setPermission(() => new Promise<void>(resolve => { allow = resolve; }));
    main.window.require("electron").ipcRenderer.sendTo(child.id, "route", "old");
    const changed = side === "sender" ? main : child;
    if (side === "sender") h.sources.setMain(changed.source); else h.sources.registerChild("a", changed.source);
    const identity = h.sources.currentIdentityForHost(changed.source)!;
    h.router.bind(changed.role, changed.source, identity, true);
    allow(); await h.settle();
    expect(h.deliveries.filter(d => d.message.__atools_hosted_ipc__)).toHaveLength(0);
    expect(h.router.stats().pending).toBe(0);
  });

  it("preserves webContents.send ownership and routes sendToParent to the exact creator", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main), nested = await h.frame("nested", child);
    child.evaluate("window.up=[];window.require('electron').ipcRenderer.on('up',function(e,n){window.up.push([e.senderId,n]);});");
    await nested.window.utools.sendToParent("up", 3); await h.settle();
    expect(child.window.up).toEqual([[nested.id, 3]]);
    const nativeRequest = h.receivedNative.find(d => d.method === "sendToParent");
    expect(nativeRequest.args.browserWindowId).toBe("nested");
    // A sibling can exchange IPC, but still cannot acquire the other's window controls.
    const sibling = await h.frame("sibling", main);
    sibling.evaluate("window.p=window.utools.sendToParent('unused');");
    await sibling.window.p;
    const nonce = sibling.posted.find(data => data.__atools_hosted_ipc_document__).documentNonce;
    sibling.evaluate(`window.parent.postMessage({__atools_native_call__:true,reqId:999,hostedDocumentNonce:'${nonce}',method:'browserWindowAction',args:{id:' a ',action:' webContents.send ',args:['forged',1]}},'*');`);
    await h.settle();
    expect(h.deliveries.some(d => d.message.__atools_hosted_ipc__ && d.message.channel === "forged")).toBe(false);
    expect(h.deliveries.some(d => d.target === sibling.id && d.message.reqId === 999 && /not owned/.test(d.message.error))).toBe(true);
    expect(h.router.stats().pending).toBe(0);
  });

  it("rejects invalid IDs, channels and oversized JSON before transport and remains idle without timers", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const baseline = h.receivedNative.length;
    for (const call of ["ipc.sendTo(0,'route')", "ipc.sendTo(1,'')", "ipc.sendTo(1,'route',undefined)", "ipc.sendTo(1,'route','x'.repeat(17000))"]) {
      expect(() => main.evaluate("var ipc=window.require('electron').ipcRenderer;" + call)).toThrow();
    }
    await h.settle();
    expect(h.receivedNative.length).toBe(baseline); expect(timer).not.toHaveBeenCalled();
    expect(h.router.stats().pending).toBe(0);
  });
  it("bounds frame JSON traversal and pending sends before native transport", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main);
    main.evaluate("window.getterReads=0;var ipc=window.require('electron').ipcRenderer;");
    for (const expression of ["new Array(1000000)", "Object.fromEntries(Array.from({length:1500},(_,n)=>['key'+n,n]))",
      "'x'.repeat(1000000)", "'文'.repeat(6000)", "{get value(){window.getterReads++;return 1;}}"])
      expect(() => main.evaluate(`ipc.sendTo(${child.id},'limit',${expression});`)).toThrow();
    expect(main.window.getterReads).toBe(0);
    expect(h.receivedNative.filter(d => d.method === "sendTo")).toHaveLength(0);
    h.setPermission(() => new Promise(() => {}));
    main.evaluate(`for(var n=0;n<32;n++)ipc.sendTo(${child.id},'pending',n);`);
    expect(() => main.evaluate(`ipc.sendTo(${child.id},'pending',33);`)).toThrow("pending message budget");
    expect(h.router.stats().pending).toBe(32);
    h.router.clear();
    expect(h.router.stats().pendingBytes).toBe(0);
  });
  it("uses a new runtime nonce for cached srcdoc on the same WindowProxy before any load event", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), old = await h.frame("a", main);
    main.window.require("electron").ipcRenderer.sendTo(old.id, "route", "old-packet"); await h.settle();
    const packet = h.deliveries.find(d => d.message.__atools_hosted_ipc__).message;
    const replacement = await h.frame("a", main, true, old, true);
    expect(replacement.source).toBe(old.source); expect(replacement.identity.generation).toBe(old.identity.generation);
    replacement.evaluate("window.messages=[];window.require('electron').ipcRenderer.on('route',function(e,n){window.messages.push(n);});");
    replacement.host(packet); // A late postMessage already addressed to the old document.
    expect(replacement.window.messages).toEqual([]);
    replacement.flushLifecycle(); h.router.markReady(replacement.role, replacement.source, replacement.identity);
    main.window.require("electron").ipcRenderer.sendTo(replacement.id, "route", "current"); await h.settle();
    expect(replacement.window.messages).toEqual(["current"]);
    expect(replacement.posted[0].documentNonce).not.toBe(old.posted[0].documentNonce);
  });
  it.each(["sender", "target"])("cancels a %s runtime nonce rotation during the production permission wait", async side => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main);
    let allow!: () => void; h.setPermission(() => new Promise<void>(resolve => { allow = resolve; }));
    main.window.require("electron").ipcRenderer.sendTo(child.id, "route", "stale");
    const replacement = side === "sender" ? await h.frame(undefined, undefined, true, main) : await h.frame("a", main, true, child);
    expect(replacement.identity.generation).toBeGreaterThan((side === "sender" ? main : child).identity.generation);
    allow(); await h.settle();
    expect(h.deliveries.some(d => d.message.__atools_hosted_ipc__)).toBe(false);
    expect(h.router.stats().pending).toBe(0);
  });
  it("registers its runtime nonce before an early preload IPC call and rejects forged document roles", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main, false);
    main.evaluate("window.early=[];window.require('electron').ipcRenderer.on('early',function(e,n){window.early.push([e.senderId,n]);});");
    child.evaluate(`window.require('electron').ipcRenderer.sendTo(${main.id},'early','preload');`); await h.settle();
    expect(main.window.early).toEqual([[child.id, "preload"]]);
    expect(child.posted[0].__atools_hosted_ipc_document__).toBe(true);
    expect(child.posted[1].method).toBe("sendTo");
    expect(() => h.router.handleLifecycle(child, { __atools_hosted_ipc_document__: true, webContentsId: main.id,
      documentNonce: "f".repeat(32), phase: "open" })).toThrow("handshake");
  });
  it("keeps the confirmed runtime identity through the actual main load callback while an early create is pending", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), mount = h.mountMain(main);
    let create!: () => void; h.setCreateGate(() => new Promise<void>(resolve => { create = resolve; }));
    main.evaluate("window.child=window.utools.createBrowserWindow('preload-child.html');"); await h.settle();
    const before = h.sources.currentIdentityForHost(main.source)!;
    mount.load();
    expect(h.sources.currentIdentityForHost(main.source)?.generation).toBe(before.generation);
    create(); await h.settle();
    await expect(main.window.child.ready).resolves.toBe(main.window.child);
    expect(main.window.child.webContents.id).toBe(h.frames[1].id);
  });
  it("consumes fresh-open evidence once and invalidates a second load without a new bridge handshake", async () => {
    const h = await productionHostedIpcFixture(), main = await h.frame(), child = await h.frame("a", main), mount = h.mountMain(main);
    const lease = h.router.captureDocumentLease(main, main.posted[0].documentNonce);
    const before = h.sources.currentIdentityForHost(main.source)!;
    mount.load();
    expect(h.sources.currentIdentityForHost(main.source)?.generation).toBe(before.generation);
    expect(() => lease.assertCurrent()).not.toThrow();
    const message = h.router.capture(main, child.id, "pending", []);
    mount.load();
    expect(h.sources.currentIdentityForHost(main.source)?.generation).toBeGreaterThan(before.generation);
    expect(() => lease.assertCurrent()).toThrow("lease");
    await expect(message.deliver()).rejects.toThrow(/replayed|current/);
    expect(h.router.stats().pending).toBe(0);
  });
  it.each(["shellOpenExternal", "copyFile", "createBrowserWindow"])("blocks old-document %s after the production permission wait and runtime rotation", async method => {
    const h = await productionHostedIpcFixture(), main = await h.frame();
    let allow!: () => void; h.setPermission(() => new Promise<void>(resolve => { allow = resolve; }));
    const nonce = main.posted[0].documentNonce;
    main.evaluate(`window.parent.postMessage({__atools_native_call__:true,reqId:900,method:'${method}',hostedDocumentNonce:'${nonce}',args:{url:'child.html',file:'/fixture/item'}},'*');`);
    expect(typeof allow).toBe("function");
    await h.frame(undefined, undefined, true, main);
    allow(); await h.settle();
    expect(h.nativeSinks).toHaveLength(0);
    expect(h.frames).toHaveLength(2);
  });
  it("does not send stale native errors to a new document with a reused request number", async () => {
    const h = await productionHostedIpcFixture(), old = await h.frame(), child = await h.frame("a", old);
    const replacement = await h.frame(undefined, undefined, true, old);
    let allow!: () => void; h.setPermission(() => new Promise<void>(resolve => { allow = resolve; }));
    replacement.window.require("electron").ipcRenderer.sendTo(child.id, "route", "current");
    const oldNonce = old.posted[0].documentNonce;
    old.evaluate(`window.parent.postMessage({__atools_native_call__:true,reqId:1,method:'shellOpenExternal',hostedDocumentNonce:'${oldNonce}',args:{url:'old'}},'*');`);
    await h.settle();
    expect(h.errors).toHaveLength(0);
    expect(h.deliveries.some(d => d.target === replacement.id && d.message.__atools_native_response__)).toBe(false);
    allow(); await h.settle();
    expect(h.deliveries.filter(d => d.message.__atools_hosted_ipc__)).toHaveLength(1);
    expect(h.nativeSinks).toHaveLength(0);
  });
});
