type ByteBufferFactory = {
  from(value: Uint8Array): Uint8Array;
  isBuffer(value: unknown): boolean;
};

type ReadPngPath = (path: string) => unknown;
type CreateNativeImage = (bytes: Uint8Array) => unknown;
type NativeImageTransformPath = { supports: () => boolean; openPath: (path: string) => unknown };

/** Synchronous path adapter for the active, permission-gated legacy Node session. */
export function createPluginNativeImagePathFactory(
  readPngPath: ReadPngPath | undefined,
  browserBuffer: ByteBufferFactory,
  createNativeImage: CreateNativeImage,
  transformPath?: NativeImageTransformPath,
) {
  const maxPathBytes = 8192;
  const maxPngBytes = 512 * 1024;

  function fail(code: string, message: string): never {
    const error = new TypeError(message) as TypeError & { code: string };
    error.code = code;
    throw error;
  }

  function isAbsoluteLocalPath(path: string): boolean {
    return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
  }

  return function createFromPath(path: unknown, ...options: unknown[]) {
    if (options.length || typeof path !== "string" || !path || path.length > maxPathBytes || path.includes("\0")
        || new TextEncoder().encode(path).byteLength > maxPathBytes || !isAbsoluteLocalPath(path)) {
      fail("ERR_ATOOLS_IMAGE_PATH_INVALID", "createFromPath requires a bounded absolute local path");
    }
    if (transformPath?.supports()) return transformPath.openPath(path);
    if (typeof readPngPath !== "function") {
      fail("ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE", "createFromPath requires an active Node file-read session");
    }
    const raw = readPngPath(path);
    if (!(raw instanceof Uint8Array) || raw.byteLength < 33 || raw.byteLength > maxPngBytes) {
      fail("ERR_ATOOLS_IMAGE_PATH_RESPONSE", "Bounded PNG reader returned an invalid image payload");
    }
    // Take an owned BrowserBuffer copy before the NativeImage factory can retain bytes.
    const snapshot = browserBuffer.from(new Uint8Array(raw));
    if (!browserBuffer.isBuffer(snapshot)) {
      fail("ERR_ATOOLS_IMAGE_PATH_RESPONSE", "Could not snapshot the PNG bytes");
    }
    return createNativeImage(snapshot);
  };
}
