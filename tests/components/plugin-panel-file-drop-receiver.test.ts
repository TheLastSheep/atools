import { describe, expect, it, vi } from "vitest";
import { createPluginPanelFileDropReceiver, type ReceiverWindow } from "../../src/lib/pluginPanelFileDropReceiver";
import { parsePluginFileDropPacket } from "../../src/lib/pluginFileDropPacket";
import { createPluginFileIdentityRegistry } from "../../src/lib/pluginFileIdentity";

const PARENT_NONCE = "0123456789abcdef0123456789abcdef";
const INSTANCE = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";

function packet() {
  const raw = new TextEncoder().encode("approved file bytes");
  const header = new TextEncoder().encode(JSON.stringify({ requestId: REQUEST, leaseId: LEASE,
    expiresAt: Date.now() + 30_000, files: [{ name: "fixture.txt", path: "/private/approved/fixture.txt",
      type: "text/plain", lastModified: 123, size: raw.byteLength, offset: 0 },
      { name: "empty.bin", path: "/private/approved/empty.bin", type: "application/octet-stream", lastModified: 0, size: 0, offset: raw.byteLength }] }));
  const value = new ArrayBuffer(9 + header.byteLength + raw.byteLength), bytes = new Uint8Array(value), view = new DataView(value);
  bytes.set([65, 84, 70, 68, 1]); view.setUint32(5, header.byteLength, true); bytes.set(header, 9); bytes.set(raw, 9 + header.byteLength);
  return value;
}

class FakeTransfer {
  files: File[] = [];
  items = { add: (file: File) => { this.files.push(file); } };
}
class FakeDragEvent extends Event {
  dataTransfer: FakeTransfer;
  clientX: number;
  clientY: number;
  constructor(type: string, init: { dataTransfer: FakeTransfer; clientX: number; clientY: number }) {
    super(type, { bubbles: true, cancelable: true });
    this.dataTransfer = init.dataTransfer; this.clientX = init.clientX; this.clientY = init.clientY;
  }
}

describe("native file-drop receiver and exact File identity", () => {
  it("dispatches a synthetic drop and resolves only the exact native-approved File repeatedly", () => {
    const listeners = new Map<string, EventListener>(), parent = {};
    const target = document.createElement("div"), dispatched: FakeDragEvent[] = [];
    target.dispatchEvent = vi.fn(event => { dispatched.push(event as FakeDragEvent); return true; });
    const host = {
      parent, document: { elementFromPoint: vi.fn(() => target) }, innerWidth: 640, innerHeight: 480,
      File, DataTransfer: FakeTransfer, DragEvent: FakeDragEvent,
      addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); },
    } as unknown as ReceiverWindow;
    const receiver = createPluginPanelFileDropReceiver(host, { pluginId: "fixture.plugin", windowType: "main", windowId: "", documentNonce: PARENT_NONCE },
      parsePluginFileDropPacket, createPluginFileIdentityRegistry);
    expect(receiver.getPathForFile).toBe(host.__ATOOLS_FILE_DROP_IDENTITY__?.getPathForFile);
    const send = (data: Record<string, unknown>) => listeners.get("message")!(new MessageEvent("message", { source: parent as MessageEventSource, data }));
    send({ __atools_plugin_file_drop__: true, phase: "bind", pluginId: "fixture.plugin", windowType: "main", windowId: "",
      documentNonce: PARENT_NONCE, frameGeneration: 7, instanceId: INSTANCE });
    send({ __atools_plugin_file_drop__: true, phase: "deliver", pluginId: "fixture.plugin", windowType: "main", windowId: "",
      documentNonce: PARENT_NONCE, frameGeneration: 7, instanceId: INSTANCE, requestId: REQUEST,
      packet: packet(), x: 12, y: 18, contentWidth: 640, contentHeight: 480 });
    expect(dispatched.map(event => event.type)).toEqual(["dragenter", "dragover", "drop"]);
    expect(dispatched[2].isTrusted).toBe(false);
    const file = dispatched[2].dataTransfer.files[0];
    const empty = dispatched[2].dataTransfer.files[1];
    expect(file).toBeInstanceOf(File);
    expect(empty.size).toBe(0);
    expect(receiver.getPathForFile(file)).toBe("/private/approved/fixture.txt");
    expect(receiver.getPathForFile(file)).toBe("/private/approved/fixture.txt");
    expect(receiver.getPathForFile(empty)).toBe("/private/approved/empty.bin");
    expect(() => receiver.getPathForFile(new File(["same bytes"], file.name))).toThrow("ERR_ATOOLS_FILE_PATH_UNAVAILABLE");
    send({ __atools_plugin_file_drop__: true, phase: "revoke", pluginId: "fixture.plugin", windowType: "main", windowId: "",
      documentNonce: PARENT_NONCE, frameGeneration: 7, instanceId: INSTANCE, leaseId: LEASE });
    expect(() => receiver.getPathForFile(file)).toThrow("ERR_ATOOLS_FILE_PATH_UNAVAILABLE");
    receiver.close();
  });

  it("rejects wrong parent, stale nonce, wrong request, malformed packet and out-of-viewport points", () => {
    const listeners = new Map<string, EventListener>(), parent = {}, target = document.createElement("div");
    const host = { parent, document: { elementFromPoint: vi.fn(() => target) }, innerWidth: 640, innerHeight: 480,
      File, DataTransfer: FakeTransfer, DragEvent: FakeDragEvent,
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type) } as unknown as ReceiverWindow;
    createPluginPanelFileDropReceiver(host, { pluginId: "fixture.plugin", windowType: "main", windowId: "", documentNonce: PARENT_NONCE },
      parsePluginFileDropPacket, createPluginFileIdentityRegistry);
    const send = (source: object, data: Record<string, unknown>) => listeners.get("message")!(new MessageEvent("message", { source: source as MessageEventSource, data }));
    send({}, { __atools_plugin_file_drop__: true, phase: "bind", pluginId: "fixture.plugin", windowType: "main", windowId: "",
      documentNonce: PARENT_NONCE, frameGeneration: 7, instanceId: INSTANCE });
    send(parent, { __atools_plugin_file_drop__: true, phase: "bind", pluginId: "fixture.plugin", windowType: "main", windowId: "",
      documentNonce: "f".repeat(32), frameGeneration: 7, instanceId: INSTANCE });
    const bad = packet(); new Uint8Array(bad)[0] = 0;
    send(parent, { __atools_plugin_file_drop__: true, phase: "deliver", pluginId: "fixture.plugin", windowType: "main", windowId: "",
      documentNonce: PARENT_NONCE, frameGeneration: 7, instanceId: INSTANCE, requestId: REQUEST,
      packet: bad, x: 12, y: 18, contentWidth: 640, contentHeight: 480 });
    expect(host.document.elementFromPoint).not.toHaveBeenCalled();
    expect(host.__ATOOLS_FILE_DROP_IDENTITY__?.getPathForFile).toBeTypeOf("function");
  });

  it("uses the native 256 UTF-8 byte plugin identity limit", () => {
    const makeHost = () => ({ parent: {}, document: { elementFromPoint: vi.fn() }, innerWidth: 640, innerHeight: 480,
      File, DataTransfer: FakeTransfer, DragEvent: FakeDragEvent,
      addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as ReceiverWindow;
    const config = { windowType: "main" as const, windowId: "", documentNonce: PARENT_NONCE };
    const accepted = createPluginPanelFileDropReceiver(makeHost(), { ...config, pluginId: "p".repeat(256) },
      parsePluginFileDropPacket, createPluginFileIdentityRegistry);
    accepted.close();
    const acceptedMultibyte = createPluginPanelFileDropReceiver(makeHost(), { ...config, pluginId: "é".repeat(128) },
      parsePluginFileDropPacket, createPluginFileIdentityRegistry);
    acceptedMultibyte.close();
    expect(() => createPluginPanelFileDropReceiver(makeHost(), { ...config, pluginId: "p".repeat(257) },
      parsePluginFileDropPacket, createPluginFileIdentityRegistry)).toThrow("ERR_ATOOLS_FILE_DROP_RECEIVER_BINDING");
    expect(() => createPluginPanelFileDropReceiver(makeHost(), { ...config, pluginId: "é".repeat(129) },
      parsePluginFileDropPacket, createPluginFileIdentityRegistry)).toThrow("ERR_ATOOLS_FILE_DROP_RECEIVER_BINDING");
  });
});
