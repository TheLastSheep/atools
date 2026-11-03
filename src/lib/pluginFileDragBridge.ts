export type PluginFileDragConfig = { endpoint: string };
export type PluginFileDragTransport = (endpoint: string, requestBody: string) => string;

const endpointPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/file-drag\/[0-9a-f]{64}$/;

export function isPluginFileDragEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = endpointPattern.exec(value);
  return Boolean(match && Number(match[1]) <= 65535);
}

/** Runs inside the plugin's own isolated document and needs no host imports. */
export function createPluginFileDragBridge(config: PluginFileDragConfig, injected?: PluginFileDragTransport) {
  const endpoint = config.endpoint;
  const match = typeof endpoint === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/file-drag\/[0-9a-f]{64}$/.exec(endpoint);
  if (!match || Number(match[1]) > 65535) throw makeError("ERR_ATOOLS_FILE_DRAG_CONFIG", "File drag session is invalid");
  let closed = false;

  function makeError(code: string, message: string) {
    const error = new Error(`${code}: ${message}`) as Error & { code: string };
    error.name = "PluginFileDragError";
    error.code = code;
    return error;
  }

  function bytes(value: string) {
    return new TextEncoder().encode(value).byteLength;
  }

  function paths(value: unknown): string[] {
    if (typeof value !== "string" && !Array.isArray(value)) {
      throw makeError("ERR_ATOOLS_FILE_DRAG_PATHS", "Expected one absolute path or an array of paths");
    }
    const input: unknown[] = typeof value === "string" ? [value] : value;
    if (input.length < 1 || input.length > 16) {
      throw makeError("ERR_ATOOLS_FILE_DRAG_PATHS", "Expected between 1 and 16 paths");
    }
    const unique: string[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const path of input) {
      if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
        throw makeError("ERR_ATOOLS_FILE_DRAG_PATH", "Paths must be absolute NUL-free paths");
      }
      const pathBytes = bytes(path);
      if (pathBytes > 8 * 1024) throw makeError("ERR_ATOOLS_FILE_DRAG_LIMIT", "A path exceeds 8 KiB");
      if (seen.has(path)) continue;
      seen.add(path);
      unique.push(path);
      totalBytes += pathBytes;
    }
    if (totalBytes > 64 * 1024) throw makeError("ERR_ATOOLS_FILE_DRAG_LIMIT", "Paths exceed 64 KiB");
    return unique;
  }

  function send(requestBody: string): string {
    if (injected) return injected(endpoint, requestBody);
    const xhr = new XMLHttpRequest();
    try {
      xhr.open("POST", endpoint, false);
      xhr.withCredentials = false;
      // A simple content type avoids preflight from this opaque-origin frame.
      xhr.setRequestHeader("Content-Type", "text/plain");
      xhr.send(requestBody);
    } catch {
      throw makeError("ERR_ATOOLS_FILE_DRAG_TRANSPORT", "File drag session is unavailable");
    }
    if (xhr.status !== 200 || xhr.responseURL !== endpoint) {
      throw makeError("ERR_ATOOLS_FILE_DRAG_TRANSPORT", "File drag session is unavailable");
    }
    return xhr.responseText;
  }

  function startDrag(value: string | string[]): void {
    if (closed) throw makeError("ERR_ATOOLS_FILE_DRAG_CLOSED", "File drag session is closed");
    const checkedPaths = paths(value);
    const body = JSON.stringify({ paths: checkedPaths });
    if (bytes(body) > 64 * 1024) throw makeError("ERR_ATOOLS_FILE_DRAG_LIMIT", "File drag request exceeds 64 KiB");
    let responseText: string;
    try { responseText = send(body); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw makeError("ERR_ATOOLS_FILE_DRAG_TRANSPORT", "File drag request failed");
    }
    if (typeof responseText !== "string" || bytes(responseText) > 4 * 1024) {
      throw makeError("ERR_ATOOLS_FILE_DRAG_RESPONSE_LIMIT", "File drag response exceeds 4 KiB");
    }
    let envelope: unknown;
    try { envelope = JSON.parse(responseText); }
    catch { throw makeError("ERR_ATOOLS_FILE_DRAG_RESPONSE", "File drag response is invalid"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw makeError("ERR_ATOOLS_FILE_DRAG_RESPONSE", "File drag response is invalid");
    }
    const reply = envelope as Record<string, unknown>;
    if (reply.ok === false && reply.error && typeof reply.error === "object" && !Array.isArray(reply.error)) {
      const nativeError = reply.error as Record<string, unknown>;
      const code = typeof nativeError.code === "string" ? nativeError.code : "rejected";
      throw makeError("ERR_ATOOLS_FILE_DRAG_REJECTED", `File drag was rejected (${code})`);
    }
    if (reply.ok !== true || Object.keys(reply).length !== 2 || !reply.result
      || typeof reply.result !== "object" || Array.isArray(reply.result)
      || Object.keys(reply.result).length !== 1 || (reply.result as Record<string, unknown>).started !== true) {
      throw makeError("ERR_ATOOLS_FILE_DRAG_RESPONSE", "File drag did not start");
    }
    // The native acknowledgement means the session was created. OS drop/cancel is
    // tracked by TaskRun separately, so this API deliberately returns no value.
  }

  function close() { closed = true; }
  return { startDrag, close };
}

/** Produces the standalone bootstrap installed before the public ZTools bridge. */
export function pluginFileDragBridgeScript(config?: PluginFileDragConfig): string {
  if (!config || !isPluginFileDragEndpoint(config.endpoint)) return "";
  const serializedConfig = JSON.stringify(config).replace(/</g, "\\u003c");
  return `<script data-atools-file-drag="true">(function(){var bridge=(${createPluginFileDragBridge.toString()})(${serializedConfig});window.__atoolsStartDrag=bridge.startDrag;window.addEventListener('pagehide',bridge.close,{once:true});window.addEventListener('atools-plugin-out',bridge.close,{once:true});})();</script>`;
}
