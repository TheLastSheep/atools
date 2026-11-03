/** Serializable synchronous copy surface for the public plugin bridge. */
export function createPluginClipboardCopyApi(
  target: { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void },
  ports: {
    permission(): boolean;
    host(): { writeText?: (text: string) => unknown; writeContent?: (payload: Record<string, unknown>) => unknown } | undefined;
    writeImage(value: string | Uint8Array): unknown;
  },
) {
  const maxTextBytes = 256 * 1024;
  const maxImageBytes = 512 * 1024;
  const maxImageDataUrlBytes = 700 * 1024;
  const maxPathBytes = 8192;
  const maxFileCount = 20;
  const maxFilePathBytes = 64 * 1024;
  const encoder = new TextEncoder();
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const getTypedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get;
  const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
  const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
  const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
  let disposed = false;

  function utf8Length(value: string, limit: number): number {
    if (value.length > limit) return limit + 1;
    return encoder.encode(value).length;
  }

  function isAbsolutePath(value: string): boolean {
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
  }

  function validPath(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && utf8Length(value, maxPathBytes) <= maxPathBytes
      && !value.includes("\0") && isAbsolutePath(value);
  }

  function copyPaths(value: unknown): string[] | null {
    const values: unknown[] = [];
    if (typeof value === "string") values.push(value);
    else {
      try {
        if (!Array.isArray(value) || value.length < 1 || value.length > maxFileCount) return null;
        const names = Object.getOwnPropertyNames(value);
        if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== value.length + 1 || !names.includes("length")) return null;
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return null;
          values.push(descriptor.value);
        }
      } catch { return null; }
    }
    if (values.length < 1 || values.length > maxFileCount) return null;
    let bytes = 0;
    const paths: string[] = [];
    for (const value of values) {
      if (!validPath(value)) return null;
      bytes += encoder.encode(value).length;
      if (bytes > maxFilePathBytes) return null;
      paths.push(value);
    }
    return paths;
  }

  function validImageString(value: string): boolean {
    if (value.length > maxImageDataUrlBytes) return false;
    if (!value.startsWith("data:")) {
      const path = value.startsWith("file://") ? value.slice(7) : value;
      return validPath(path);
    }
    const match = /^data:image\/(png|jpeg|webp|tiff);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return false;
    const encoded = match[2];
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if (encoded.length % 4 === 1 || (padding > 0 && encoded.length % 4 !== 0)) return false;
    const decodedBytes = Math.floor(encoded.length * 3 / 4) - padding;
    return decodedBytes > 0 && decodedBytes <= maxImageBytes;
  }

  type VisibleImageBytes = { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
  function visibleImageBytes(value: unknown): VisibleImageBytes | null {
    if (!value || typeof value !== "object") return null;
    try {
      if (!ArrayBuffer.isView(value)) return null;
      if (!getTypedArrayTag || !getTypedArrayBuffer || !getTypedArrayByteOffset || !getTypedArrayByteLength
        || getTypedArrayTag.call(value) !== "Uint8Array") return null;
      const byteLength = getTypedArrayByteLength.call(value) as number;
      if (byteLength < 1 || byteLength > maxImageBytes) return null;
      return {
        buffer: getTypedArrayBuffer.call(value) as ArrayBufferLike,
        byteOffset: getTypedArrayByteOffset.call(value) as number,
        byteLength,
      };
    } catch { return null; }
  }

  function snapshotImageBytes(value: VisibleImageBytes): Uint8Array | null {
    try {
      const visible = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const snapshot = new Uint8Array(value.byteLength);
      snapshot.set(visible);
      return snapshot;
    } catch { return null; }
  }

  function hostForWrite() {
    if (disposed) return undefined;
    try {
      if (ports.permission() !== true) return undefined;
      const host = ports.host();
      if (!host || typeof host !== "object") return undefined;
      return host;
    } catch { return undefined; }
  }

  function acceptSynchronousCompletion(result: unknown): boolean {
    if (result === null || result === undefined) return true;
    try {
      if ((typeof result === "object" && result !== null) || typeof result === "function") {
        if (typeof (result as { then?: unknown }).then === "function") {
          Promise.resolve(result).catch(function() { /* synchronous API reports false; do not replay */ });
        }
      }
    } catch { /* a hostile or malformed return value is a failed write */ }
    return false;
  }

  function copyText(text: unknown): boolean {
    if (disposed || arguments.length !== 1 || typeof text !== "string" || utf8Length(text, maxTextBytes) > maxTextBytes) return false;
    const host = hostForWrite();
    if (!host) return false;
    try {
      const writeText = host.writeText;
      if (typeof writeText !== "function") return false;
      return acceptSynchronousCompletion(writeText.call(host, text));
    } catch { return false; }
  }

  function copyImage(image: unknown): boolean {
    if (disposed || arguments.length !== 1) return false;
    let payload: string | undefined;
    let imageBytes: VisibleImageBytes | undefined;
    if (typeof image === "string") {
      if (!validImageString(image)) return false;
      payload = image.startsWith("file://") ? image.slice(7) : image;
    } else {
      const bytes = visibleImageBytes(image);
      if (!bytes) return false;
      imageBytes = bytes;
    }
    if (!hostForWrite()) return false;
    try {
      if (imageBytes) {
        const snapshot = snapshotImageBytes(imageBytes);
        if (!snapshot) return false;
        return acceptSynchronousCompletion(ports.writeImage(snapshot));
      }
      return acceptSynchronousCompletion(ports.writeImage(payload as string));
    } catch { return false; }
  }

  function copyFile(file: unknown): boolean {
    if (disposed || arguments.length !== 1) return false;
    const paths = copyPaths(file);
    if (!paths) return false;
    const host = hostForWrite();
    if (!host) return false;
    try {
      const writeContent = host.writeContent;
      if (typeof writeContent !== "function") return false;
      return acceptSynchronousCompletion(writeContent.call(host, { kind: "files", paths }));
    } catch { return false; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try { target.removeEventListener("pagehide", dispose); } catch { /* lifecycle cleanup is best effort */ }
    try { target.removeEventListener("atools-plugin-out", dispose); } catch { /* lifecycle cleanup is best effort */ }
  }

  target.addEventListener("pagehide", dispose);
  target.addEventListener("atools-plugin-out", dispose);
  return { copyText, copyImage, copyFile, dispose };
}
