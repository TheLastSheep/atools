import { describe, expect, it } from "vitest";
import { pluginDocumentEnvelope } from "../../src/lib/pluginFrameDocumentIdentity";
import { productionHostedIpcFixture } from "./pluginHostedIpcProductionFixture";

describe("Serialized Hosted IPC through the authenticated document transport", () => {
  it("establishes its native lease after the real bootstrap ACK/claim/activation and uses the actual native entry", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const frame = await h.frame(undefined, undefined, true, undefined, false, false, true);
      const open = frame.outbound.find(value => value.message.__atools_hosted_ipc_document__);
      expect(h.claims).toEqual([frame.id]);
      expect(open.targetOrigin).toBe(frame.parentOrigin);
      expect(open.message.phase).toBe("open");
      expect(open.message.__atoolsDocument).toEqual(pluginDocumentEnvelope(frame.identity));
      expect(h.sources.identifyEvent({ source: frame.source, origin: frame.pageOrigin, data: open.message })).toEqual(frame.identity);
      expect(() => h.router.captureDocumentLease(frame, open.message.documentNonce)).not.toThrow();
      await expect(frame.window.utools.getCopyedFiles()).resolves.toEqual([
        { path: "/fixture/report.pdf", name: "report.pdf", isFile: true, isDiractory: false },
        { path: "/fixture/folder/", name: "folder", isFile: false, isDiractory: true },
      ]);
      expect(h.nativeSinks).toEqual([{ method: "getCopyedFiles", args: {} }]);
      expect(JSON.stringify(h.nativeSinks)).not.toContain(open.message.documentNonce);
      expect(frame.window.utools.getWebContentsId()).toBe(frame.id);
    } finally { h.closeDocuments(); h.closeRpc(); h.router.clear(); }
  });

  it("receives a valid document message while rejecting wrong source, origin, envelope and both nonce generations", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const frame = await h.frame(undefined, undefined, true, undefined, false, false, true);
      frame.evaluate("window.messages=[];window.require('electron').ipcRenderer.on('document',function(e,n){window.messages.push([e.senderId,n]);});");
      frame.window.require("electron").ipcRenderer.sendTo(frame.id, "document", "valid");
      await h.settle();
      expect(frame.window.messages).toEqual([[frame.id, "valid"]]);
      const message = h.deliveries.find(value => value.message.__atools_hosted_ipc__).message;
      const envelope = message.__atoolsDocument;
      for (const [data, source, origin] of [
        [message, {}, frame.parentOrigin], [message, frame.window.parent, "https://wrong.invalid"],
        [{ ...message, __atoolsDocument: undefined }, frame.window.parent, frame.parentOrigin],
        [{ ...message, __atoolsDocument: { ...envelope, docNonce: "c".repeat(32) } }, frame.window.parent, frame.parentOrigin],
        [{ ...message, __atoolsDocument: { ...envelope, generation: envelope.generation + 1 } }, frame.window.parent, frame.parentOrigin],
        [{ ...message, __atoolsDocument: { ...envelope, pageDocumentId: "other" } }, frame.window.parent, frame.parentOrigin],
        [{ ...message, targetDocumentNonce: "f".repeat(32) }, frame.window.parent, frame.parentOrigin],
      ]) frame.host(data, source, [], origin);
      expect(frame.window.messages).toEqual([[frame.id, "valid"]]);
      expect(h.errors).toEqual([]);
    } finally { h.closeDocuments(); h.closeRpc(); h.router.clear(); }
  });

  it("sends its close through the same document envelope and invalidates the lease", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const frame = await h.frame(undefined, undefined, true, undefined, false, false, true);
      const open = frame.posted.find(value => value.__atools_hosted_ipc_document__);
      const lease = h.router.captureDocumentLease(frame, open.documentNonce);
      frame.window.dispatchEvent({ type: "atools-plugin-out" });
      const close = frame.outbound.find(value => value.message.__atools_hosted_ipc_document__ && value.message.phase === "close");
      expect(close.targetOrigin).toBe(frame.parentOrigin);
      expect(close.message.__atoolsDocument).toEqual(open.__atoolsDocument);
      expect(h.sources.identifyEvent({ source: frame.source, origin: frame.pageOrigin, data: close.message })).toEqual(frame.identity);
      expect(() => lease.assertCurrent()).toThrow("lease");
      expect(h.router.stats().pending).toBe(0);
    } finally { h.closeDocuments(); h.closeRpc(); h.router.clear(); }
  });

  it("rejects an old document envelope after the same WindowProxy is reserved for another document", async () => {
    const h = await productionHostedIpcFixture();
    try {
      const frame = await h.frame(undefined, undefined, true, undefined, false, false, true);
      const open = frame.posted.find(value => value.__atools_hosted_ipc_document__);
      const lease = h.router.captureDocumentLease(frame, open.documentNonce);
      h.sources.reserveDocument({ kind: "main", source: frame.source, pageDocumentId: "replacement",
        expectedOrigin: frame.pageOrigin, parentOrigin: frame.parentOrigin });
      expect(h.sources.identifyEvent({ source: frame.source, origin: frame.pageOrigin, data: open })).toBeNull();
      expect(() => lease.assertCurrent()).toThrow("lease");
    } finally { h.closeDocuments(); h.closeRpc(); h.router.clear(); }
  });
});
