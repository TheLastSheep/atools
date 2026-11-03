import { describe, expect, it, vi } from "vitest";
import { createNativeFileTreeFrameProbe } from "./nativeFileTreeFrameProbe";

const RESULT_KIND = "atools-file-tree-head-result";
const READY_KIND = "atools-file-tree-head-ready";
const TOKEN = "fixture-token";
const DOC = "fixture-document";
const validState = {
  tree: "readme.txt", renderedTree: "readme.txt", renderedTreeChars: 9, renderedTreeOverflow: false,
  renderedTreeAvailable: true, hiddenChecked: false, ignoreValue: "", pageHasTauri: false, opaqueOrigin: true,
};

function harness(onRequest: (message: Record<string, unknown>, reply: (value: Record<string, unknown>) => void) => void) {
  const listeners: EventListener[] = [];
  const target = {
    addEventListener: (_type: string, listener: EventListener) => { listeners.push(listener); },
    removeEventListener: (_type: string, listener: EventListener) => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
  } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
  const child = {
    postMessage: (raw: unknown) => {
      const message = raw as Record<string, unknown>;
      const reply = (value: Record<string, unknown>) => {
        const event = { source: child, data: value } as MessageEvent;
        for (const listener of [...listeners]) listener(event as unknown as Event);
      };
      onRequest(message, reply);
    },
  } as unknown as Window;
  const frame = { contentWindow: child, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLIFrameElement;
  const probe = createNativeFileTreeFrameProbe({ eventTarget: target, getFrame: () => frame, token: TOKEN, timeoutMs: 80 });
  function emitFrom(source: Window, value: Record<string, unknown>) {
    const event = { source, data: value } as MessageEvent;
    for (const listener of [...listeners]) listener(event as unknown as Event);
  }
  return { probe, frame, listeners, emitFrom };
}

function readyReply(message: Record<string, unknown>, reply: (value: Record<string, unknown>) => void) {
  if (message.operation !== "ping") return false;
  reply({ kind: READY_KIND, token: TOKEN, documentId: DOC });
  reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "ping", documentId: DOC, ready: true, error: "" });
  return true;
}

describe("native FileTree frame readiness transport", () => {
  it("arms before a late ready notification and accepts only the exact frame/token", async () => {
    let replyRequest: ((value: Record<string, unknown>) => void) | null = null;
    let pingId = 0;
    const { probe, emitFrom } = harness((message, reply) => {
      if (message.operation === "ping") { replyRequest = reply; pingId = Number(message.id); return; }
      reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "state", documentId: DOC, state: validState });
    });
    const pending = probe.request("state");
    expect(replyRequest).not.toBeNull();
    replyRequest!({ kind: READY_KIND, token: "wrong-token", documentId: DOC });
    emitFrom({} as Window, { kind: READY_KIND, token: TOKEN, documentId: DOC });
    expect(probe.diagnostics().readySeen).toBe(false);
    replyRequest!({ kind: READY_KIND, token: TOKEN, documentId: DOC });
    replyRequest!({ kind: RESULT_KIND, token: TOKEN, id: pingId, operation: "ping", documentId: DOC, ready: true });
    const result = await pending;
    expect(result.tree).toBe("readme.txt");
    expect(probe.diagnostics().readySeen).toBe(true);
    probe.dispose();
  });

  it("recovers a missed ready event through a read-only ping", async () => {
    const { probe } = harness((message, reply) => {
      if (message.operation === "ping") {
        reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "ping", documentId: DOC, ready: true });
      } else {
        reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "state", documentId: DOC, state: validState });
      }
    });
    const result = await probe.request("state");
    expect(result.tree).toBe("readme.txt");
    expect(probe.diagnostics().readySeen).toBe(false);
    expect(probe.diagnostics().readyCurrent).toBe(true);
    probe.dispose();
  });

  it("retries only a read-only state request within the shared deadline", async () => {
    let stateRequests = 0;
    const { probe } = harness((message, reply) => {
      if (message.operation === "ping") {
        reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "ping", documentId: DOC, ready: true });
      } else if (message.operation === "state") {
        stateRequests += 1;
        if (stateRequests === 2) reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "state", documentId: DOC, state: validState });
      }
    });
    const result = await probe.request("state");
    expect(result.tree).toBe("readme.txt");
    expect(stateRequests).toBe(2);
    probe.dispose();
  });

  it("sends a mutable filter operation once even when its reply times out", async () => {
    const operations: string[] = [];
    const { probe } = harness((message, reply) => {
      operations.push(String(message.operation));
      readyReply(message, reply);
      // Deliberately withhold the filter result; it must not be replayed.
    });
    await expect(probe.request("filter-enter", { value: "*.log" })).rejects.toThrow("FileTree probe deadline: filter-enter");
    expect(operations.filter(operation => operation === "filter-enter")).toHaveLength(1);
    probe.dispose();
  });

  it("rejects malformed state snapshots", async () => {
    const { probe } = harness((message, reply) => {
      if (!readyReply(message, reply) && message.operation === "state") {
        reply({ kind: RESULT_KIND, token: TOKEN, id: message.id, operation: "state", documentId: DOC, state: { tree: 1 } });
      }
    });
    await expect(probe.request("state")).rejects.toThrow("FILE_TREE_FRAME_STATE_INVALID");
    probe.dispose();
  });

  it("rejects an in-flight read and sends fixture cleanup when disposed", async () => {
    const operations: string[] = [];
    const { probe, frame, listeners } = harness(message => { operations.push(String(message.operation)); });
    const pending = probe.request("state");
    probe.dispose();
    await expect(pending).rejects.toThrow("FILE_TREE_PROBE_DISPOSED");
    expect(listeners).toHaveLength(0);
    expect(frame.removeEventListener).toHaveBeenCalledTimes(1);
    expect(operations).toContain("dispose");
  });
});
