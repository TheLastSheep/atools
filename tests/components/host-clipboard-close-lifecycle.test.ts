import { describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";

const readEndpoint = "http://127.0.0.1:23456/host/" + "e".repeat(64);

describe("closed clipboard bridge lifecycle", () => {
  it("keeps a closed factory inert when valid and malformed installs arrive late", async () => {
    const requestPermission = vi.fn();
    const transport = vi.fn();
    const bridge = createHostClipboardBridge({ instanceId: "closed-factory" }, requestPermission, transport);
    const pending = bridge.ensureAccess("history_read");
    expect(requestPermission).toHaveBeenCalledWith("history_read");

    bridge.close();
    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_CLOSED" });
    expect(() => bridge.install("history_read", readEndpoint)).not.toThrow();
    expect(() => bridge.install("history_read", "invalid-endpoint")).not.toThrow();
    expect(() => bridge.install("invalid-scope" as unknown as Parameters<typeof bridge.install>[0], readEndpoint)).not.toThrow();
    await expect(bridge.ensureAccess("history_read")).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_CLOSED" });
    expect(() => bridge.historyRead({ operation: "list", page: 1, pageSize: 1 })).toThrow("ERR_ATOOLS_HOST_CLIPBOARD_CLOSED");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it("ignores late serialized session messages after the frame bridge closes", async () => {
    const messages: Array<(event: { source: object; data: Record<string, unknown> }) => void> = [];
    const parent = { postMessage: vi.fn() };
    const frameWindow: Record<string, unknown> = {};
    const xhrSend = vi.fn();
    class Xhr {
      status = 200;
      responseText = "";
      open() {}
      setRequestHeader() {}
      send() { xhrSend(); }
    }
    const script = hostClipboardBridgeScript({ instanceId: "serialized-closed" })
      .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "parent", "addEventListener", "XMLHttpRequest", script)(
      frameWindow, parent, (_type: string, listener: (event: { source: object; data: Record<string, unknown> }) => void) => messages.push(listener), Xhr,
    );
    const bridge = frameWindow.__atoolsHostClipboard as ReturnType<typeof createHostClipboardBridge>;
    const pending = bridge.ensureAccess("history_read");
    bridge.close();
    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_CLOSED" });

    const receive = messages[0]!;
    expect(() => receive({ source: parent, data: {
      __atools_host_clipboard_session__: true, instanceId: "serialized-closed", access: "history_read", endpoint: readEndpoint,
    } })).not.toThrow();
    expect(() => receive({ source: parent, data: {
      __atools_host_clipboard_session__: true, instanceId: "serialized-closed", access: "invalid-scope", endpoint: "bad",
    } })).not.toThrow();
    expect(() => bridge.historyRead({ operation: "list", page: 1, pageSize: 1 })).toThrow("ERR_ATOOLS_HOST_CLIPBOARD_CLOSED");
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(xhrSend).not.toHaveBeenCalled();
  });
});
