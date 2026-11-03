import type { NodeModuleRequire, NodeModuleTransport } from "./nodeModuleProtocol";

/** Serialized into the plugin iframe; dependencies must be passed or defined here. */
export function createNodeNativeFilesystem(
  transport: Pick<NodeModuleTransport, "requestSync">,
  assertOpen: () => void,
): Required<Pick<NodeModuleRequire, "readTextPath" | "writeTextPath">> {
  function failure(message: string, code: string) {
    return Object.assign(new Error(message), { code });
  }

  function withinBytes(value: unknown, limit: number): value is string {
    if (typeof value !== "string" || value.length > limit) return false;
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(++index);
        if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
      else bytes += 3;
      if (bytes > limit) return false;
    }
    return true;
  }

  function validatePath(path: unknown): asserts path is string {
    if (!withinBytes(path, 8192) || !path.startsWith("/") || path.includes("\0")) {
      throw failure("Invalid native text path", "ERR_ATOOLS_NATIVE_FS_REQUEST");
    }
  }

  function request(method: string, params: Record<string, unknown>, path: string, syscall: string): unknown {
    try {
      return transport.requestSync(method, params);
    } catch (error) {
      const code = error instanceof Error
        && /^ERR_ATOOLS_NATIVE_FS:(ENOENT|EACCES|EIO|ENOTDIR|EINVAL|ENAMETOOLONG|ENOTSUP|ENOSPC|EROFS|EEXIST|EFBIG|EISDIR|ELOOP|ETIMEDOUT)$/.exec(error.message)?.[1];
      if (!code) throw error;
      // The plugin already owns this argument; paths never enter durable TaskRun output.
      throw Object.assign(new Error(`${code}: ${syscall}`), { code, syscall, path });
    }
  }

  function reply(raw: unknown): { handled: boolean; value?: string } {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const keys = Reflect.ownKeys(raw);
      const handled = Object.getOwnPropertyDescriptor(raw, "handled");
      if (handled && "value" in handled && typeof handled.value === "boolean") {
        if (keys.length === 1 && keys[0] === "handled") return { handled: handled.value };
        const value = Object.getOwnPropertyDescriptor(raw, "value");
        if (handled.value === true && keys.length === 2 && keys.includes("value")
          && value && "value" in value && typeof value.value === "string") {
          return { handled: true, value: value.value };
        }
      }
    }
    throw failure("Invalid native text response", "ERR_ATOOLS_NATIVE_FS_RESPONSE");
  }

  return {
    readTextPath(path) {
      assertOpen();
      validatePath(path);
      const result = reply(request("readTextPath", { path }, path, "open"));
      if (result.handled === false) return { handled: false };
      if (typeof result.value === "string") return { handled: true, value: result.value };
      throw failure("Invalid native text read response", "ERR_ATOOLS_NATIVE_FS_RESPONSE");
    },
    writeTextPath(path, text) {
      assertOpen();
      validatePath(path);
      if (!withinBytes(text, 512 * 1024)) {
        throw failure("Invalid native text body", "ERR_ATOOLS_NATIVE_FS_REQUEST");
      }
      const result = reply(request("writeTextPath", { path, text }, path, "write"));
      if (Object.prototype.hasOwnProperty.call(result, "value")) {
        throw failure("Invalid native text write response", "ERR_ATOOLS_NATIVE_FS_RESPONSE");
      }
      return result.handled ? { handled: true } : { handled: false };
    },
  };
}
