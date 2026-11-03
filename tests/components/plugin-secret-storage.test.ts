import { describe, expect, it, vi } from "vitest";
import { Buffer as NodeBuffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createBrowserBuffer } from "../../src/lib/browserBuffer";
import { createPluginSecretStorageBridge, pluginSecretStorageBridgeScript } from "../../src/lib/pluginSecretStorageBridge";
import { createPluginSecretStorageController } from "../../src/lib/pluginSecretStorageController";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";

const endpoint = "http://127.0.0.1:43821/secrets/" + "a".repeat(64);
const config = { instanceId: "123e4567-e89b-42d3-a456-426614174000", endpoint, available: true as const };

describe("authorized page safeStorage bridge", () => {
  it("keeps availability local and uses one synchronous bounded request per operation", () => {
    const buffers = createBrowserBuffer(), calls: unknown[][] = [];
    const bridge = createPluginSecretStorageBridge(config, buffers, (url, body) => {
      calls.push([url, JSON.parse(body)]);
      return body.includes('"method":"encrypt"')
        ? JSON.stringify({ ok: true, result: { data: "AQID" } })
        : JSON.stringify({ ok: true, result: { text: "凭据🔐" } });
    });
    expect(bridge.isEncryptionAvailable()).toBe(true);
    expect(calls).toEqual([]);
    const ciphertext = bridge.encryptString("凭据🔐");
    expect(buffers.isBuffer(ciphertext)).toBe(true);
    expect(bridge.decryptString(ciphertext)).toBe("凭据🔐");
    expect(calls).toEqual([
      [endpoint, { method: "encrypt", text: "凭据🔐" }],
      [endpoint, { method: "decrypt", data: "AQID" }],
    ]);
  });

  it("accepts a callable Buffer constructor as a direct codec, not as a getter", () => {
    const calls: Record<string, unknown>[] = [];
    const ciphertexts = new Map<string, string>();
    const bridge = createPluginSecretStorageBridge(config, NodeBuffer, (_url, body) => {
      const request = JSON.parse(body) as Record<string, string>; calls.push(request);
      if (request.method === "encrypt") {
        const data = NodeBuffer.from(`fixture:${request.text}`).toString("base64");
        ciphertexts.set(data, request.text);
        return JSON.stringify({ ok: true, result: { data } });
      }
      return JSON.stringify({ ok: true, result: { text: ciphertexts.get(request.data) } });
    });
    const encrypted = bridge.encryptString("callable Buffer");
    expect(NodeBuffer.isBuffer(encrypted)).toBe(true);
    expect(bridge.decryptString(encrypted)).toBe("callable Buffer");
    expect(calls.map(request => request.method)).toEqual(["encrypt", "decrypt"]);
  });

  it("rejects invalid Buffer, unsupported/stale endpoint and oversized input before transport", () => {
    const buffers = createBrowserBuffer(), transport = vi.fn(() => "{}");
    const bridge = createPluginSecretStorageBridge(config, buffers, transport);
    expect(() => bridge.decryptString("AQID")).toThrow("Buffer");
    expect(() => bridge.encryptString("x".repeat(64 * 1024 + 1))).toThrow("64 KiB");
    const unavailable = createPluginSecretStorageBridge({ ...config, available: false }, buffers, transport);
    expect(unavailable.isEncryptionAvailable()).toBe(false);
    expect(() => unavailable.encryptString("secret")).toThrow("UNAVAILABLE");
    expect(transport).not.toHaveBeenCalled();
    const invalidPort = createPluginSecretStorageBridge({ ...config, endpoint: endpoint.replace(":43821", ":99999") }, buffers, transport);
    expect(invalidPort.isEncryptionAvailable()).toBe(false);
    expect(() => invalidPort.encryptString("secret")).toThrow("UNAVAILABLE");
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds Buffer length and base64 output before transport", () => {
    const buffers = createBrowserBuffer(), transport = vi.fn(() => "{}");
    const bridge = createPluginSecretStorageBridge(config, buffers, transport);
    const oversizedBase64 = buffers.from("AQID", "base64");
    Object.defineProperty(oversizedBase64, "toString", { value: () => "A".repeat(128 * 1024) });
    expect(() => bridge.decryptString(oversizedBase64)).toThrow("格式");
    expect(transport).not.toHaveBeenCalled();
  });

  it("requires reentry for legacy unknown ciphertext and reports the local session close", () => {
    const buffers = createBrowserBuffer();
    const legacy = createPluginSecretStorageBridge(config, buffers, () => JSON.stringify({ ok: false, error: { message: "unsupported_format" } }));
    const cipher = buffers.from("AQID", "base64");
    expect(() => legacy.decryptString(cipher)).toThrow("重新录入凭据");
    legacy.close();
    expect(legacy.isEncryptionAvailable()).toBe(false);
    expect(() => legacy.decryptString(cipher)).toThrow("UNAVAILABLE");
  });

  it("exposes only the explicitly supplied session adapter on Electron safeStorage", () => {
    const buffers = createBrowserBuffer();
    const bridge = createPluginSecretStorageBridge(config, buffers, () => JSON.stringify({ ok: true, result: { data: "AQID" } }));
    const electron = createPluginElectronAdapter({ application: { name: "ATools", version: "1" }, safeStorage: bridge });
    expect(electron.safeStorage.isEncryptionAvailable()).toBe(true);
    expect(buffers.isBuffer(electron.safeStorage.encryptString("value"))).toBe(true);
    const unavailable = createPluginElectronAdapter({ application: { name: "ATools", version: "1" } });
    expect(() => unavailable.safeStorage.isEncryptionAvailable()).toThrow("UNSUPPORTED");
  });
});

describe("preload safeStorage authorization", () => {
  it("waits for the exact capability TaskRun then returns only the owner-bound endpoint", async () => {
    const calls: unknown[][] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === "prepare_plugin_secret_storage") return { permission_required: true, runId: "run-1", tool: "atools.host.secret-storage.123" };
      if (command === "get_task_run") return { id: "run-1", capabilityId: "atools.host.secret-storage.123", initiator: { clientId: "atools-ui" }, status: "succeeded", output: { sessionId: "123e4567-e89b-42d3-a456-426614174000" } };
      if (command === "get_plugin_secret_storage_session") return { endpoint, available: true };
      return null;
    });
    const controller = createPluginSecretStorageController(invoke, "plugin", () => true, () => {}, async () => {});
    const ready = await controller.prepare();
    expect(ready).toMatchObject({ endpoint, available: true });
    expect(calls.map(call => call[0])).toEqual(["prepare_plugin_secret_storage", "get_task_run", "get_plugin_secret_storage_session"]);
    expect(calls[0]?.[1]).toMatchObject({ pluginId: "plugin", requestPermission: true });
    await controller.close();
    expect(calls[calls.length - 1]?.[0]).toBe("close_plugin_secret_storage");
  });

  it("does not expose a session after denied or stale TaskRun", async () => {
    const invoke = vi.fn(async (command: string) => command === "prepare_plugin_secret_storage"
      ? { permission_required: true, runId: "run-2", tool: "secret" }
      : { id: "run-2", capabilityId: "secret", initiator: { clientId: "atools-ui" }, status: "cancelled" });
    const controller = createPluginSecretStorageController(invoke, "plugin", () => true, () => {}, async () => {});
    await expect(controller.prepare()).rejects.toThrow("PERMISSION_DENIED");
    expect(invoke).not.toHaveBeenCalledWith("get_plugin_secret_storage_session", expect.anything());
    await controller.close();
  });

  it("drains a late prepare exactly once when its document closes", async () => {
    let finishPrepare!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command === "prepare_plugin_secret_storage"
      ? new Promise(resolve => { finishPrepare = resolve; }) : Promise.resolve(null));
    const controller = createPluginSecretStorageController(invoke, "plugin", () => true, () => {}, async () => {});
    const opening = controller.prepare();
    await controller.close();
    finishPrepare({ sessionId: "123e4567-e89b-42d3-a456-426614174000" });
    await expect(opening).rejects.toThrow("CANCELLED");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "prepare_plugin_secret_storage", "close_plugin_secret_storage",
    ]);
  });

  it("runs the production-generated bridge in a VM and preserves the pinned cc-switch codec contract", () => {
    const requests: Record<string, unknown>[] = [];
    const ciphertexts = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    class SyncRequest {
      status = 200;
      responseURL = "";
      responseText = "";
      private target = "";
      open(method: string, url: string, asynchronous: boolean) {
        expect(method).toBe("POST"); expect(asynchronous).toBe(false); this.target = url;
      }
      setRequestHeader(name: string, value: string) { expect(name).toBe("Content-Type"); expect(value).toBe("application/json"); }
      send(body: string) {
        const request = JSON.parse(body) as Record<string, string>; requests.push(request); this.responseURL = this.target;
        if (request.method === "encrypt") {
          const data = NodeBuffer.from(`fixture:${request.text}`, "utf8").toString("base64");
          ciphertexts.set(data, request.text); this.responseText = JSON.stringify({ ok: true, result: { data } });
        } else this.responseText = JSON.stringify({ ok: true, result: { text: ciphertexts.get(request.data) } });
      }
    }
    const window = {
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as Window & Record<string, unknown>;
    const tag = pluginSecretStorageBridgeScript(config);
    const script = tag.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    runInNewContext(script, { window, XMLHttpRequest: SyncRequest, TextEncoder, TextDecoder, btoa, atob, Uint8Array, ArrayBuffer });
    const bridge = window.__atoolsSafeStorage as ReturnType<typeof createPluginSecretStorageBridge>;
    const browserBytes = bridge.encryptString("浏览器 Buffer🔐");
    expect(browserBytes).toBeInstanceOf(Uint8Array);
    expect(NodeBuffer.isBuffer(browserBytes)).toBe(false);
    expect(bridge.decryptString(browserBytes)).toBe("浏览器 Buffer🔐");

    window.__atoolsNodeModuleRequire = {
      createLocalBuffer: (value: string, encoding: string) => NodeBuffer.from(value, encoding as BufferEncoding),
      isLocalBuffer: (value: unknown) => NodeBuffer.isBuffer(value),
    };
    const nodeBytes = bridge.encryptString("Node Buffer🔐");
    expect(NodeBuffer.isBuffer(nodeBytes)).toBe(true);
    expect(bridge.decryptString(nodeBytes)).toBe("Node Buffer🔐");

    const original = readFileSync(resolve(process.cwd(), "ZTools-plugins/plugins/ztools-cc-switch/preload/index.js"), "utf8");
    expect(createHash("sha256").update(original).digest("hex")).toBe("d853385345beced8fdf5a094de0d6f77980b5669526b125244f87e1644212d57");
    const start = original.indexOf("function createSecretCodec() {");
    const end = original.indexOf("\nconst ztoolsStorage", start);
    const codecSource = original.slice(start, end + 1);
    expect(createHash("sha256").update(codecSource).digest("hex")).toBe("54e3ef5a05aa3cedf67506fdae4720e49301077fe2875ddd7ee6dfd23bc0a9ec");
    const codec = runInNewContext(`(${codecSource})()`, {
      Buffer: NodeBuffer,
      require: (name: string) => name === "electron" ? { safeStorage: bridge } : undefined,
      console: { warn: () => {} },
    }) as { secure: boolean; encode(value: string): string; decode(value: string): string };
    expect(codec.secure).toBe(true);
    for (const value of ["fresh nonsecret 中文🔐", ""]) expect(codec.decode(codec.encode(value))).toBe(value);
    expect(requests).toHaveLength(8);
    listeners.get("pagehide")?.();
    expect(bridge.isEncryptionAvailable()).toBe(false);
  });
});
