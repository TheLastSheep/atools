import type { PluginClipboardImagePayload } from "./pluginNativeImage";

type NativeImageLike = {
  isEmpty(): boolean;
  toDataURL(...args: unknown[]): string;
  toPNG(...args: unknown[]): Uint8Array;
  getSize(...args: unknown[]): { width: number; height: number };
};
type BufferLike = Uint8Array & { toString(encoding?: string): string };
type BufferFactory = {
  isBuffer(value: unknown): boolean;
  from(value: Uint8Array): BufferLike;
};
type PayloadValidator = (
  value: unknown,
  createImage?: (dataUrl: string | null, width: number, height: number, bytes?: Uint8Array) => NativeImageLike,
) => PluginClipboardImagePayload | null;
type ImageCreator = (dataUrl: string | null, width: number, height: number, bytes?: Uint8Array) => NativeImageLike;
type ExternalImageCreator = (bytes: Uint8Array) => NativeImageLike;
type ExternalDataUrlCreator = (dataUrl: string) => NativeImageLike;
type ImageDecorator = (image: NativeImageLike, snapshot: Readonly<PluginClipboardImagePayload>) => NativeImageLike;
type DecoratedPayload = (image: unknown) => PluginClipboardImagePayload;

/**
 * Self-contained Electron NativeImage factory set. The weak registry is the only
 * authority for clipboard.writeImage; method-shaped objects are never accepted.
 */
export function createPluginNativeImageFactories(
  validatePayload: PayloadValidator,
  createImageFromBytes: ImageCreator,
  getBuffer: () => BufferFactory | undefined,
  getBrowserBuffer: () => BufferFactory | undefined = () => undefined,
  decorateImage?: ImageDecorator,
  createExternalImage?: ExternalImageCreator,
  createExternalDataUrl?: ExternalDataUrlCreator,
  decoratedPayload?: DecoratedPayload,
) {
  const maxPngBytes = 512 * 1024;
  const maxDataUrlBytes = 700 * 1024;
  const maxSide = 8192;
  const maxPixels = 16_000_000;
  const prefix = "data:image/png;base64,";
  const snapshots = new WeakMap<object, Readonly<PluginClipboardImagePayload | { dataUrl: null; width: 0; height: 0 }>>();
  function failure(message: string): Error {
    const error = new TypeError("ERR_ATOOLS_ELECTRON_NATIVE_IMAGE: " + message) as TypeError & { code: string };
    error.code = "ERR_ATOOLS_ELECTRON_NATIVE_IMAGE";
    return error;
  }
  function dimensions(bytes: Uint8Array): { width: number; height: number } {
    if (bytes.byteLength < 33 || bytes.byteLength > maxPngBytes
        || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
        || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
        || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
      throw failure("createFromBuffer accepts only bounded PNG bytes");
    }
    const width = bytes[16] * 0x1000000 + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
    const height = bytes[20] * 0x1000000 + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
    if (width < 1 || height < 1 || width > maxSide || height > maxSide || width * height > maxPixels) {
      throw failure("PNG dimensions exceed the supported limit");
    }
    return { width, height };
  }
  function dimensionsFromDataUrl(dataUrl: unknown): { width: number; height: number } {
    if (typeof dataUrl !== "string" || dataUrl.length > maxDataUrlBytes || !dataUrl.startsWith(prefix)) {
      throw failure("createFromDataURL accepts only bounded PNG data URLs");
    }
    const encoded = dataUrl.slice(prefix.length);
    if (encoded.length < 44 || encoded.length > Math.ceil(maxPngBytes / 3) * 4 || encoded.length % 4 !== 0) {
      throw failure("PNG data URL exceeds the supported limit");
    }
    let header: string;
    try { header = atob(encoded.slice(0, 44)); } catch { throw failure("Invalid PNG data URL"); }
    const bytes = Uint8Array.from(header, character => character.charCodeAt(0));
    return dimensions(bytes);
  }
  function remember(image: NativeImageLike, value: PluginClipboardImagePayload | null): NativeImageLike {
    if (!image || typeof image !== "object") throw failure("NativeImage factory returned an invalid value");
    const snapshot = value === null
      ? Object.freeze({ dataUrl: null as null, width: 0 as const, height: 0 as const })
      : Object.freeze({ dataUrl: value.dataUrl, width: value.width, height: value.height });
    if (value !== null && decorateImage) {
      const decorated = decorateImage(image, snapshot as Readonly<PluginClipboardImagePayload>);
      if (decorated !== image) throw failure("NativeImage decorator must preserve the original image identity");
    }
    Object.freeze(image);
    snapshots.set(image, snapshot);
    return image;
  }
  function fromPayload(value: unknown): NativeImageLike {
    const normalized = validatePayload(value, createImageFromBytes);
    if (normalized === null) return remember(createImageFromBytes(null, 0, 0), null);
    const create = (normalized as PluginClipboardImagePayload & { __atoolsCreateNativeImage?: () => NativeImageLike }).__atoolsCreateNativeImage;
    if (typeof create !== "function") throw failure("Validated image factory is unavailable");
    return remember(create(), normalized);
  }
  function createEmpty(...args: unknown[]): NativeImageLike {
    if (args.length) throw failure("createEmpty options are unsupported");
    return remember(createImageFromBytes(null, 0, 0), null);
  }
  function createFromBuffer(value: unknown, ...args: unknown[]): NativeImageLike {
    if (args.length) throw failure("createFromBuffer options are unsupported");
    const BufferCtor = getBuffer();
    if (!BufferCtor || typeof BufferCtor.isBuffer !== "function" || !BufferCtor.isBuffer(value)) {
      throw failure("createFromBuffer requires the host Buffer facade");
    }
    const input = value as Uint8Array;
    if (input.byteLength < 33 || input.byteLength > maxPngBytes) throw failure("PNG bytes exceed the supported limit");
    if (!(input[0] === 137 && input[1] === 80 && input[2] === 78 && input[3] === 71)) {
      if (!createExternalImage) throw failure("createFromBuffer accepts only bounded PNG bytes");
      return createExternalImage(BufferCtor.from(input));
    }
    const size = dimensions(input);
    const immutable = BufferCtor.from(input);
    const dataUrl = prefix + immutable.toString("base64");
    return fromPayload({ dataUrl, width: size.width, height: size.height });
  }
  function createFromBrowserBuffer(value: unknown): NativeImageLike {
    const BufferCtor = getBrowserBuffer();
    if (!BufferCtor || typeof BufferCtor.isBuffer !== "function" || !BufferCtor.isBuffer(value)) {
      throw failure("createFromPath requires a BrowserBuffer snapshot");
    }
    const input = value as Uint8Array;
    if (input.byteLength < 33 || input.byteLength > maxPngBytes) throw failure("PNG bytes exceed the supported limit");
    const size = dimensions(input);
    const immutable = BufferCtor.from(input);
    const dataUrl = prefix + immutable.toString("base64");
    return fromPayload({ dataUrl, width: size.width, height: size.height });
  }
  function createFromDataURL(value: unknown, ...args: unknown[]): NativeImageLike {
    if (args.length) throw failure("createFromDataURL options are unsupported");
    if (typeof value === "string" && !value.startsWith(prefix)) {
      if (!createExternalDataUrl || value.length > maxDataUrlBytes
          || !/^data:image\/(?:jpeg|webp|tiff);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw failure("createFromDataURL accepts only bounded supported image data URLs");
      }
      return createExternalDataUrl(value);
    }
    const size = dimensionsFromDataUrl(value);
    return fromPayload({ dataUrl: value, width: size.width, height: size.height });
  }
  function payloadForWrite(value: unknown): PluginClipboardImagePayload {
    if (value && typeof value === "object" && snapshots.has(value as object)) {
      const snapshot = snapshots.get(value as object)!;
      if (snapshot.dataUrl === null) throw failure("clipboard.writeImage rejects an empty NativeImage");
      return { dataUrl: snapshot.dataUrl, width: snapshot.width, height: snapshot.height };
    }
    if (decoratedPayload) {
      const payload = decoratedPayload(value);
      const validated = validatePayload(payload);
      if (validated === null || validated.dataUrl !== payload.dataUrl
          || validated.width !== payload.width || validated.height !== payload.height) {
        throw failure("clipboard.writeImage requires a validated NativeImage PNG payload");
      }
      return { dataUrl: validated.dataUrl, width: validated.width, height: validated.height };
    }
    throw failure("clipboard.writeImage requires an ATools NativeImage");
  }
  return { createEmpty, createFromBuffer, createFromBrowserBuffer, createFromDataURL, fromPayload, payloadForWrite };
}
