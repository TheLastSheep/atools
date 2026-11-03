export type PluginClipboardImagePayload = { dataUrl: string; width: number; height: number };
type PreparedPluginClipboardImage = PluginClipboardImagePayload & { __atoolsCreateNativeImage?: () => ReturnType<typeof createPluginNativeImageFromBytes> };
type NativeImageFactory = (dataUrl: string | null, width: number, height: number, bytes?: Uint8Array) => ReturnType<typeof createPluginNativeImageFromBytes>;

/** Validate the bounded JSON value returned by the private clipboard-image transport. */
export function validatePluginClipboardImagePayload(
  value: unknown,
  createImage?: NativeImageFactory,
): PluginClipboardImagePayload | null {
  const maxPngBytes = 512 * 1024;
  const maxDataUrlBytes = 700 * 1024;
  const maxSide = 8192;
  const maxPixels = 16_000_000;
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid clipboard image response");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || typeof input.dataUrl !== "string"
      || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
    throw new TypeError("Invalid clipboard image response");
  }
  const width = input.width as number, height = input.height as number;
  if (width < 1 || height < 1 || width > maxSide || height > maxSide
      || width * height > maxPixels || input.dataUrl.length > maxDataUrlBytes) {
    throw new RangeError("Clipboard image exceeds the supported size");
  }
  const prefix = "data:image/png;base64,";
  if (!input.dataUrl.startsWith(prefix)) throw new TypeError("Invalid clipboard image data URL");
  const encoded = input.dataUrl.slice(prefix.length);
  if (!encoded || encoded.length % 4 !== 0 || encoded.length > Math.ceil(maxPngBytes / 3) * 4) {
    throw new RangeError("Clipboard image exceeds the supported size");
  }
  let paddingStart = encoded.indexOf("=");
  if (paddingStart < 0) paddingStart = encoded.length;
  const padding = encoded.length - paddingStart;
  if (padding > 2 || (padding === 1 && paddingStart % 4 !== 3) || (padding === 2 && paddingStart % 4 !== 2)) {
    throw new TypeError("Invalid clipboard image data URL");
  }
  for (let index = 0; index < encoded.length; index++) {
    const code = encoded.charCodeAt(index);
    const base64Character = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (index < paddingStart ? !base64Character : code !== 61) throw new TypeError("Invalid clipboard image data URL");
  }
  let binary: string;
  try { binary = atob(encoded); } catch { throw new TypeError("Invalid clipboard image data URL"); }
  if (binary.length < 33 || binary.length > maxPngBytes) throw new RangeError("Clipboard image exceeds the supported size");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)
      || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
      || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new TypeError("Clipboard image is not a PNG");
  }
  const pngWidth = bytes[16] * 0x1000000 + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
  const pngHeight = bytes[20] * 0x1000000 + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
  if (pngWidth !== width || pngHeight !== height) throw new TypeError("Clipboard image dimensions do not match");
  const normalized: PreparedPluginClipboardImage = { dataUrl: input.dataUrl, width, height };
  if (createImage) {
    const validatedDataUrl = normalized.dataUrl;
    Object.defineProperty(normalized, "__atoolsCreateNativeImage", {
      value: () => createImage(validatedDataUrl, width, height, bytes),
    });
  }
  return normalized;
}

/** Build the minimal synchronous Electron NativeImage facade from request-local validated bytes. */
export function createPluginNativeImageFromBytes(dataUrl: string | null, width: number, height: number, bytes?: Uint8Array) {
  const empty = dataUrl === null;
  const encoded = empty ? "" : dataUrl.slice(dataUrl.indexOf(",") + 1);
  function pngBuffer(): Uint8Array {
    const BufferConstructor = (globalThis as typeof globalThis & { Buffer?: { from(value: string | Uint8Array, encoding?: string): Uint8Array } }).Buffer;
    if (!BufferConstructor || typeof BufferConstructor.from !== "function") {
      throw new Error("ERR_ATOOLS_ELECTRON_UNSUPPORTED: Buffer is unavailable for NativeImage.toPNG");
    }
    if (bytes) return BufferConstructor.from(bytes);
    const binary = encoded ? atob(encoded) : "";
    return BufferConstructor.from(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  }
  return {
    isEmpty: () => empty,
    toDataURL: (...args: unknown[]) => {
      if (args.length) throw new TypeError("ERR_ATOOLS_ELECTRON_UNSUPPORTED: NativeImage.toDataURL options");
      return empty ? "data:image/png;base64," : dataUrl;
    },
    toPNG: (...args: unknown[]) => {
      if (args.length) throw new TypeError("ERR_ATOOLS_ELECTRON_UNSUPPORTED: NativeImage.toPNG options");
      return pngBuffer();
    },
    getSize: (...args: unknown[]) => {
      if (args.length) throw new TypeError("ERR_ATOOLS_ELECTRON_UNSUPPORTED: NativeImage.getSize options");
      return empty ? { width: 0, height: 0 } : { width, height };
    },
  };
}

/** Standalone fallback used when callers pass a plain response rather than a bridge result. */
export function createPluginNativeImage(
  value: unknown,
  validate: typeof validatePluginClipboardImagePayload = validatePluginClipboardImagePayload,
  createImage: NativeImageFactory = createPluginNativeImageFromBytes,
) {
  // Always validate the caller's current value. The factory below belongs to the fresh
  // normalized result from this validation call, never to a caller-supplied marker.
  const image = validate(value, createImage);
  if (image === null) return createImage(null, 0, 0);
  const prepared = (image as PreparedPluginClipboardImage).__atoolsCreateNativeImage;
  return typeof prepared === "function"
    ? prepared()
    : createImage(image.dataUrl, image.width, image.height);
}
