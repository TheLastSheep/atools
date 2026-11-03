import { browserBufferFactoryScript } from "./browserBuffer";

export type PluginSecretStorageConfig = { instanceId: string; endpoint: string; available: boolean };
type BufferCodec = { from(value: string, encoding: string): unknown; isBuffer(value: unknown): boolean };
type BufferSource = BufferCodec | { resolveBuffer: () => BufferCodec };
type SyncTransport = (endpoint: string, body: string) => string;

/** The serialized page adapter has no permission queue and never retains a request. */
export function createPluginSecretStorageBridge(
  config: PluginSecretStorageConfig, buffers: BufferSource, transport?: SyncTransport,
) {
  const maxText = 64 * 1024, maxCipher = maxText + 64, maxJson = 128 * 1024;
  const endpointPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/secrets\/[0-9a-f]{64}$/;
  const instancePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const failureCodes = new Set(["invalid_request", "input_too_large", "ciphertext_too_large", "invalid_ciphertext",
    "unsupported_format", "decrypt_failed", "encrypt_failed", "keychain_unavailable", "response_too_large",
    "session_unavailable", "request_rejected"]);
  let closed = false;
  const error = (code: string, message: string) => Object.assign(new Error(code + ": " + message), { code });
  const encoder = () => new TextEncoder();
  const activeBuffers = () => typeof buffers === "object" && buffers !== null && "resolveBuffer" in buffers
    ? buffers.resolveBuffer() : buffers;
  function endpointMatch(value: unknown): RegExpExecArray | null {
    if (typeof value !== "string" || value.length > 128) return null;
    const match = endpointPattern.exec(value);
    return match && Number(match[1]) <= 65535 ? match : null;
  }
  function checkedEndpoint(): string {
    if (closed || config.available !== true || !endpointMatch(config.endpoint)
      || !instancePattern.test(config.instanceId)) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_UNAVAILABLE", "安全存储会话不可用");
    }
    return config.endpoint;
  }
  function jsonSize(value: string, limit: number, label: string): void {
    if (value.length > limit) throw error("ERR_ATOOLS_SECRET_STORAGE_LIMIT", label);
    if (encoder().encode(value).byteLength > limit) throw error("ERR_ATOOLS_SECRET_STORAGE_LIMIT", label);
  }
  function send(body: Record<string, unknown>): Record<string, unknown> {
    const target = checkedEndpoint();
    const serialized = JSON.stringify(body);
    jsonSize(serialized, maxJson, "安全存储请求超过大小限制");
    let responseText: string;
    try {
      if (transport) responseText = transport(target, serialized);
      else {
        const request = new XMLHttpRequest();
        request.open("POST", target, false);
        request.withCredentials = false;
        request.setRequestHeader("Content-Type", "application/json");
        request.send(serialized);
        if (request.status !== 200 || request.responseURL !== target) throw error("ERR_ATOOLS_SECRET_STORAGE_SESSION", "安全存储会话已关闭");
        responseText = request.responseText;
      }
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (typeof code === "string" && code.startsWith("ERR_ATOOLS_SECRET_STORAGE_")) throw cause;
      throw error("ERR_ATOOLS_SECRET_STORAGE_SESSION", "安全存储请求失败");
    }
    jsonSize(responseText, maxJson, "安全存储响应超过大小限制");
    let envelope: unknown;
    try { envelope = JSON.parse(responseText); }
    catch { throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "安全存储响应无效"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "安全存储响应无效");
    }
    const result = envelope as Record<string, unknown>;
    if (result.ok === false && Object.keys(result).length === 2 && result.error && typeof result.error === "object") {
      const failure = result.error as Record<string, unknown>;
      const code = typeof failure.code === "string" ? failure.code : failure.message;
      if ((Object.keys(failure).length !== 1 && Object.keys(failure).length !== 2)
        || (Object.keys(failure).length === 2 && !(typeof failure.code === "string" && failure.code === failure.message))
        || typeof code !== "string" || !failureCodes.has(code)) {
        throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "安全存储响应无效");
      }
      const message = code === "unsupported_format" ? "旧版或未知格式的密文不受支持，请重新录入凭据"
        : code === "keychain_unavailable" ? "系统安全存储不可用，请重新打开插件"
          : code === "session_unavailable" ? "安全存储会话已失效，请重新打开插件" : "安全存储操作失败";
      throw error("ERR_ATOOLS_SECRET_STORAGE_REJECTED", message);
    }
    if (result.ok !== true || Object.keys(result).length !== 2 || !result.result
      || typeof result.result !== "object" || Array.isArray(result.result)) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "安全存储响应无效");
    }
    return result.result as Record<string, unknown>;
  }
  function encryptString(text: unknown): unknown {
    if (typeof text !== "string") throw new TypeError("safeStorage.encryptString expects a string");
    if (text.length > maxText) throw error("ERR_ATOOLS_SECRET_STORAGE_LIMIT", "明文超过 64 KiB 限制");
    if (encoder().encode(text).byteLength > maxText) throw error("ERR_ATOOLS_SECRET_STORAGE_LIMIT", "明文超过 64 KiB 限制");
    const result = send({ method: "encrypt", text });
    if (Object.keys(result).length !== 1 || typeof result.data !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data)
      || result.data.length > Math.ceil(maxCipher / 3) * 4) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "加密响应无效");
    }
    const codec = activeBuffers();
    const bytes = codec.from(result.data, "base64") as { length?: number; toString(encoding: string): string };
    if (!codec.isBuffer(bytes) || !bytes.length || bytes.length > maxCipher || bytes.toString("base64") !== result.data) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "加密结果无效");
    }
    return bytes;
  }
  function decryptString(value: unknown): string {
    if (!activeBuffers().isBuffer(value)) throw new TypeError("safeStorage.decryptString expects a Buffer");
    const candidate = value as { length?: number; toString(encoding: string): string };
    const length = candidate.length;
    if (!Number.isSafeInteger(length) || length! < 0 || length! > maxCipher) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_LIMIT", "密文超过大小限制");
    }
    const data = candidate.toString("base64");
    if (typeof data !== "string" || data.length > Math.ceil(maxCipher / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_FORMAT", "密文格式无效，请重新录入凭据");
    }
    const result = send({ method: "decrypt", data });
    if (Object.keys(result).length !== 1 || typeof result.text !== "string"
      || result.text.length > maxText
      || encoder().encode(result.text).byteLength > maxText) {
      throw error("ERR_ATOOLS_SECRET_STORAGE_RESPONSE", "解密响应无效");
    }
    return result.text;
  }
  return { isEncryptionAvailable: () => !closed && config.available === true && !!endpointMatch(config.endpoint)
    && instancePattern.test(config.instanceId), encryptString, decryptString, close: () => { closed = true; } };
}

/** Install only after a detected preload has an authorized, prewarmed session. */
export function pluginSecretStorageBridgeScript(config: PluginSecretStorageConfig): string {
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<script data-atools-secret-storage>(function(){var browser=(${browserBufferFactoryScript()})();` +
    `var buffers=function(){var session=window.__atoolsNodeModuleRequire;if(session&&typeof session.createLocalBuffer==="function")return {from:function(v,e){return session.createLocalBuffer(v,e);},isBuffer:function(v){return typeof session.isLocalBuffer==="function"&&session.isLocalBuffer(v);}};return window.Buffer||browser;};` +
    `var bridge=(${createPluginSecretStorageBridge.toString()})(${serialized},{resolveBuffer:buffers});window.__atoolsSafeStorage=bridge;` +
    `window.addEventListener("pagehide",bridge.close,{once:true});})();</script>`;
}

