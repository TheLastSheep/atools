type ByteFactory = {
  from(value: string | Uint8Array, encoding?: string): Uint8Array & { toString(encoding?: string): string };
  isBuffer(value: unknown): boolean;
};
type Session = {
  nativeImageRequestSync?: (operation: string, params: Record<string, unknown>) => unknown;
};
type Format = "png" | "jpeg" | "webp" | "tiff";
type Size = { width: number; height: number };
type ResizeStep = { width?: number; height?: number; quality: "good" | "better" | "best" };
type Descriptor = { handleId: string; format: Format; width: number; height: number };
type PlanState = {
  source: { session?: Session; descriptor?: Descriptor };
  dataUrl?: string;
  bytes?: Uint8Array;
  format: Format;
  size: Size;
  plan: readonly ResizeStep[];
  empty: boolean;
};
type ImageLike = {
  isEmpty(): boolean;
  toDataURL(...args: unknown[]): string;
  toPNG(...args: unknown[]): Uint8Array;
  toJPEG(quality?: number, ...args: unknown[]): Uint8Array;
  getSize(...args: unknown[]): Size;
  resize(options?: unknown): ImageLike;
};

/** Private synchronous NativeImage transform provider; serialize this function with the adapter. */
export function createPluginNativeImageTransformProvider(
  getSession: () => Session | undefined,
  getBuffer: () => ByteFactory | undefined,
) {
  const maxSourceBytes = 512 * 1024;
  const maxEncodedBytes = 512 * 1024;
  const maxSide = 8192;
  const maxPixels = 16_000_000;
  const maxPlan = 4;
  const states = new WeakMap<object, PlanState>();

  function fail(code: string, message: string): never {
    const error = new Error(message) as Error & { code: string };
    error.name = "NativeImageTransformError";
    error.code = code;
    throw error;
  }
  function dimensions(width: unknown, height: unknown): Size {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || (width as number) < 1 || (height as number) < 1
        || (width as number) > maxSide || (height as number) > maxSide
        || (width as number) * (height as number) > maxPixels) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage dimensions");
    }
    return { width: width as number, height: height as number };
  }
  function format(value: unknown): Format {
    if (value === "png" || value === "jpeg" || value === "webp" || value === "tiff") return value;
    return fail("ERR_ATOOLS_NATIVE_IMAGE_FORMAT", "Unsupported NativeImage format");
  }
  function exactKeys(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage response");
    }
    const record = value as Record<string, unknown>;
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage response");
    }
    return record;
  }
  function invoke(operation: "openPath" | "openBuffer" | "encode", params: Record<string, unknown>): unknown {
    const session = getSession();
    if (!session || typeof session.nativeImageRequestSync !== "function") {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_SESSION_REQUIRED", "An active Node image session is required");
    }
    const response = session.nativeImageRequestSync(operation, params);
    return { session, response };
  }
  function descriptor(value: unknown): Descriptor {
    const record = exactKeys(value, ["handleId", "format", "width", "height"]);
    if (typeof record.handleId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.handleId)) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage handle");
    }
    return {
      handleId: record.handleId,
      format: format(record.format),
      ...dimensions(record.width, record.height),
    };
  }
  function sourceFormat(bytes: Uint8Array): Format {
    if (bytes.byteLength < 4 || bytes.byteLength > maxSourceBytes) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_SOURCE_LIMIT", "NativeImage source exceeds the supported limit");
    }
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "png";
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
    if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
        && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "webp";
    if ((bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0)
        || (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42)) return "tiff";
    return fail("ERR_ATOOLS_NATIVE_IMAGE_FORMAT", "Unsupported NativeImage source format");
  }
  function pngSize(bytes: Uint8Array): Size {
    if (bytes.byteLength < 33 || sourceFormat(bytes) !== "png"
        || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
        || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid encoded PNG header");
    }
    return dimensions(
      bytes[16] * 0x1000000 + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19],
      bytes[20] * 0x1000000 + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23],
    );
  }
  function image(state: PlanState): ImageLike {
    const result: ImageLike = {
      isEmpty: () => state.empty,
      getSize: (...args: unknown[]) => {
        if (args.length) return fail("ERR_ATOOLS_NATIVE_IMAGE_OPTIONS", "NativeImage.getSize options are unsupported");
        return { ...state.size };
      },
      resize: (options?: unknown) => resize(state, options),
      toPNG: (...args: unknown[]) => {
        if (args.length) return fail("ERR_ATOOLS_NATIVE_IMAGE_OPTIONS", "NativeImage.toPNG options are unsupported");
        return encode(state, "png").bytes;
      },
      toJPEG: (quality?: number, ...args: unknown[]) => {
        if (args.length || !Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100) {
          return fail("ERR_ATOOLS_NATIVE_IMAGE_JPEG_QUALITY", "NativeImage.toJPEG requires an integer quality from 0 to 100");
        }
        return encode(state, "jpeg", quality as number).bytes;
      },
      toDataURL: (...args: unknown[]) => {
        if (args.length) return fail("ERR_ATOOLS_NATIVE_IMAGE_OPTIONS", "NativeImage.toDataURL options are unsupported");
        const encoded = encode(state, "png");
        return "data:image/png;base64," + encoded.base64;
      },
    };
    states.set(result, state);
    return Object.freeze(result);
  }
  function outputSize(input: Size, options: unknown): { size: Size; quality: ResizeStep["quality"] } {
    if (options === undefined) options = {};
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESIZE_OPTIONS", "NativeImage.resize options must be an object");
    }
    const raw = options as Record<string, unknown>;
    if (Object.keys(raw).some(key => !["width", "height", "quality"].includes(key))) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESIZE_OPTIONS", "Unsupported NativeImage.resize option");
    }
    const width = raw.width === undefined ? undefined : raw.width;
    const height = raw.height === undefined ? undefined : raw.height;
    if (width === undefined && height === undefined) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESIZE_OPTIONS", "NativeImage.resize requires width or height");
    }
    for (const value of [width, height]) {
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maxSide)) {
        return fail("ERR_ATOOLS_NATIVE_IMAGE_RESIZE_OPTIONS", "Invalid NativeImage.resize dimensions");
      }
    }
    const quality = raw.quality === undefined ? "best" : raw.quality;
    if (quality !== "good" && quality !== "better" && quality !== "best") {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESIZE_OPTIONS", "Unsupported NativeImage.resize quality");
    }
    let nextWidth: number, nextHeight: number;
    if (width !== undefined && height !== undefined) {
      nextWidth = width as number;
      nextHeight = height as number;
    } else {
      const ratio = Math.fround(input.width / input.height);
      if (width === undefined) {
        nextWidth = Math.round(Math.fround((height as number) * ratio));
        nextHeight = height as number;
      } else {
        const factor = Math.fround(1 / ratio);
        nextWidth = width as number;
        nextHeight = Math.round(Math.fround((width as number) * factor));
      }
    }
    const size = dimensions(nextWidth, nextHeight);
    return { size, quality };
  }
  function resize(current: PlanState, options: unknown): ImageLike {
    const next = outputSize(current.size, options);
    if (current.plan.length >= maxPlan) return fail("ERR_ATOOLS_NATIVE_IMAGE_PLAN_LIMIT", "NativeImage resize plan limit reached");
    const raw = options as Record<string, unknown>;
    const step: ResizeStep = { quality: next.quality };
    if (raw.width !== undefined) step.width = raw.width as number;
    if (raw.height !== undefined) step.height = raw.height as number;
    return image({ ...current, size: next.size, plan: Object.freeze([...current.plan, Object.freeze(step)]) });
  }
  function decodeBase64(base64: string, bytes: number): Uint8Array {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const expectedLength = Math.floor(base64.length * 3 / 4) - padding;
    if (!base64 || base64.length > Math.ceil(maxSourceBytes / 3) * 4
        || base64.length % 4 !== 0 || expectedLength !== bytes) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage base64 length");
    }
    const canonicalShape = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const validPadBits = padding === 2
      ? alphabet.indexOf(base64[base64.length - 3]) >= 0 && alphabet.indexOf(base64[base64.length - 3]) % 16 === 0
      : padding === 1
        ? alphabet.indexOf(base64[base64.length - 2]) >= 0 && alphabet.indexOf(base64[base64.length - 2]) % 4 === 0
        : true;
    if (!canonicalShape || !validPadBits) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage base64 length");
    }
    const BufferCtor = getBuffer();
    if (!BufferCtor || typeof BufferCtor.from !== "function") {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_BUFFER", "NativeImage Buffer facade is unavailable");
    }
    const decoded = BufferCtor.from(base64, "base64");
    if (decoded.byteLength !== bytes || decoded.toString("base64") !== base64) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage byte payload");
    }
    return decoded;
  }
  function encode(state: PlanState, target: "png" | "jpeg", jpegQuality?: number): { bytes: Uint8Array; base64: string; size: Size } {
    if (state.empty) return fail("ERR_ATOOLS_NATIVE_IMAGE_EMPTY", "Cannot encode an empty NativeImage");
    let session = state.source.session;
    let opened = state.source.descriptor;
    if (!opened) {
      const current = getSession();
      if (!current || typeof current.nativeImageRequestSync !== "function") {
        return fail("ERR_ATOOLS_NATIVE_IMAGE_SESSION_REQUIRED", "An active Node image session is required");
      }
      if (state.dataUrl) {
        if (state.dataUrl.length > 700 * 1024) return fail("ERR_ATOOLS_NATIVE_IMAGE_DATA_URL", "NativeImage data URL exceeds the supported limit");
        const match = /^data:image\/(png|jpeg|webp|tiff);base64,([A-Za-z0-9+/]+={0,2})$/.exec(state.dataUrl);
        if (!match) return fail("ERR_ATOOLS_NATIVE_IMAGE_DATA_URL", "Invalid NativeImage data URL");
        const data = match[2];
        const length = Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
        if (length > maxSourceBytes) return fail("ERR_ATOOLS_NATIVE_IMAGE_SOURCE_LIMIT", "NativeImage source exceeds the supported limit");
        const bytes = decodeBase64(data, length);
        const detected = sourceFormat(bytes);
        if (detected !== match[1]) return fail("ERR_ATOOLS_NATIVE_IMAGE_FORMAT", "NativeImage data URL format does not match its bytes");
        const result = current.nativeImageRequestSync("openBuffer", { byteLength: bytes.byteLength, dataBase64: data });
        opened = descriptor(result);
      } else if (state.bytes) {
        const detected = sourceFormat(state.bytes);
        const base64 = getBuffer()!.from(state.bytes).toString("base64");
        opened = descriptor(current.nativeImageRequestSync("openBuffer", { byteLength: state.bytes.byteLength, dataBase64: base64 }));
        if (opened.format !== detected) return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "NativeImage source format changed");
      } else {
        return fail("ERR_ATOOLS_NATIVE_IMAGE_SOURCE", "NativeImage source is unavailable");
      }
      session = current;
      state.source.session = current;
      state.source.descriptor = opened;
    } else if (!session || getSession() !== session) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_SESSION_CHANGED", "NativeImage belongs to a different Node session");
    }
    const resizePlan = Object.freeze(state.plan.map(step => Object.freeze({ ...step })));
    const params: Record<string, unknown> = {
      handleId: opened!.handleId,
      resizePlan,
      format: target,
    };
    if (target === "jpeg") params.jpegQuality = jpegQuality;
    Object.freeze(params);
    const reply = exactKeys(session!.nativeImageRequestSync!("encode", params), ["format", "width", "height", "byteLength", "dataBase64"]);
    if (reply.format !== target || !Number.isSafeInteger(reply.byteLength) || (reply.byteLength as number) < 1
        || (reply.byteLength as number) > maxEncodedBytes || typeof reply.dataBase64 !== "string") {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Invalid NativeImage encoded response");
    }
    const size = dimensions(reply.width, reply.height);
    if (size.width !== state.size.width || size.height !== state.size.height) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "NativeImage output dimensions do not match the resize plan");
    }
    const bytes = decodeBase64(reply.dataBase64, reply.byteLength as number);
    if (sourceFormat(bytes) !== target) return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "NativeImage output format is invalid");
    if (target === "png") {
      const headerSize = pngSize(bytes);
      if (headerSize.width !== size.width || headerSize.height !== size.height) {
        return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "Encoded PNG dimensions do not match the response");
      }
    }
    return { bytes, base64: reply.dataBase64, size };
  }
  function openBuffer(bytes: Uint8Array, selectedFormat?: Format): ImageLike {
    const actualFormat = sourceFormat(bytes);
    if (selectedFormat !== undefined && selectedFormat !== actualFormat) {
      return fail("ERR_ATOOLS_NATIVE_IMAGE_FORMAT", "NativeImage source format does not match its bytes");
    }
    if (bytes.byteLength > maxSourceBytes) return fail("ERR_ATOOLS_NATIVE_IMAGE_SOURCE_LIMIT", "NativeImage source exceeds the supported limit");
    const BufferCtor = getBuffer();
    if (!BufferCtor) return fail("ERR_ATOOLS_NATIVE_IMAGE_BUFFER", "NativeImage Buffer facade is unavailable");
    const owned = BufferCtor.from(bytes);
    const base64 = owned.toString("base64");
    const result = invoke("openBuffer", { byteLength: owned.byteLength, dataBase64: base64 }) as { session: Session; response: unknown };
    const opened = descriptor(result.response);
    if (opened.format !== actualFormat) return fail("ERR_ATOOLS_NATIVE_IMAGE_RESPONSE", "NativeImage source format mismatch");
    const state: PlanState = {
      source: { session: result.session, descriptor: opened }, format: opened.format,
      size: dimensions(opened.width, opened.height), plan: [], empty: false,
    };
    return image(state);
  }
  function openPath(path: string): ImageLike {
    if (typeof path !== "string" || !path || path.length > 8192 || path.includes("\0")
        || new TextEncoder().encode(path).byteLength > 8192
        || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(path))) {
      return fail("ERR_ATOOLS_IMAGE_PATH_INVALID", "createFromPath requires a bounded absolute local path");
    }
    const result = invoke("openPath", { path }) as { session: Session; response: unknown };
    const opened = descriptor(result.response);
    return image({ source: { session: result.session, descriptor: opened }, format: opened.format,
      size: dimensions(opened.width, opened.height), plan: [], empty: false });
  }
  function fromDataUrl(dataUrl: unknown): ImageLike {
    if (typeof dataUrl !== "string" || dataUrl.length > 700 * 1024) return fail("ERR_ATOOLS_NATIVE_IMAGE_DATA_URL", "NativeImage data URL must be bounded");
    const match = /^data:image\/(png|jpeg|webp|tiff);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) return fail("ERR_ATOOLS_NATIVE_IMAGE_DATA_URL", "Unsupported NativeImage data URL");
    const encoded = match[2];
    const length = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (length > maxSourceBytes) return fail("ERR_ATOOLS_NATIVE_IMAGE_SOURCE_LIMIT", "NativeImage source exceeds the supported limit");
    if (match[1] === "png") return fail("ERR_ATOOLS_NATIVE_IMAGE_LOCAL_PNG", "PNG data URL stays on the existing local factory path");
    return openBuffer(decodeBase64(encoded, length), match[1] as Format);
  }
  function decorateLocal(imageValue: ImageLike, snapshot: { dataUrl: string | null; width: number; height: number }): ImageLike {
    if (snapshot.dataUrl === null) return imageValue;
    const state: PlanState = { source: {}, dataUrl: snapshot.dataUrl, format: "png", size: dimensions(snapshot.width, snapshot.height), plan: [], empty: false };
    imageValue.resize = (options?: unknown) => resize(state, options);
    imageValue.toJPEG = (quality?: number, ...args: unknown[]) => {
      if (args.length || !Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100) {
        return fail("ERR_ATOOLS_NATIVE_IMAGE_JPEG_QUALITY", "NativeImage.toJPEG requires an integer quality from 0 to 100");
      }
      return encode(state, "jpeg", quality as number).bytes;
    };
    return imageValue;
  }
  function payloadForWrite(value: unknown): { dataUrl: string; width: number; height: number } {
    if (!value || typeof value !== "object") return fail("ERR_ATOOLS_NATIVE_IMAGE_BRAND", "clipboard.writeImage requires an ATools NativeImage with a transform brand");
    const state = states.get(value as object);
    if (!state || state.empty) return fail("ERR_ATOOLS_NATIVE_IMAGE_BRAND", "clipboard.writeImage requires an ATools NativeImage with a transform brand");
    const encoded = encode(state, "png");
    return { dataUrl: "data:image/png;base64," + encoded.base64, width: encoded.size.width, height: encoded.size.height };
  }
  return { decorateLocal, openBuffer, openPath, fromDataUrl, payloadForWrite };
}
