import { ImagePayloadError, validateImagePayload } from "./imagePayloadGuard";

// Algorithm ported from ZTools src/main/api/shared/imageAnalysis.ts at 9b15fb1a2a9f3ec886016632761c7bb21e39557a (MIT; see bundled ZTools-LICENSE).
export type ImageAnalysisResult = {
  isSimpleIcon: boolean;
  mainColor: string | null;
  isDark: boolean;
  needsAdaptation: boolean;
};

export type ImageAnalysisFailure =
  | "unsupported_source"
  | "invalid_data_image"
  | "byte_budget"
  | "pixel_budget"
  | "timeout"
  | "decode_failed"
  | "canvas_unavailable";

export type ImageAnalysisSnapshot = {
  cacheEntries: number;
  cacheHits: number;
  failures: Partial<Record<ImageAnalysisFailure, number>>;
};

export type RendererImageAnalyzer = {
  analyze(input: string): Promise<ImageAnalysisResult>;
  snapshot(): ImageAnalysisSnapshot;
  dispose(): void;
};

const MAX_INPUT_CHARS = 6 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 2 * 1024 * 1024;
const MAX_ANALYSIS_MS = 2_000;
const TARGET_SAMPLES = 1_600;
const COLOR_DISTANCE_THRESHOLD = 30;
const MAX_CACHE_ENTRIES = 64;

const NEUTRAL_RESULT: ImageAnalysisResult = {
  isSimpleIcon: false,
  mainColor: null,
  isDark: false,
  needsAdaptation: false,
};

const DATA_IMAGE_PATTERN = /^data:image\/(png|svg(?:\+xml)?);base64,([A-Za-z0-9+/]+={0,2})$/i;

export function analyzeRgbaPixels(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): ImageAnalysisResult {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Invalid image dimensions");
  }
  const totalPixels = width * height;
  if (!Number.isSafeInteger(totalPixels) || totalPixels > MAX_PIXELS) {
    throw new RangeError("Image pixel budget exceeded");
  }
  if (rgba.length !== totalPixels * 4) throw new RangeError("Invalid RGBA pixel buffer");

  const step = Math.max(1, Math.floor(totalPixels / TARGET_SAMPLES));
  const colorCounts = new Map<string, number>();
  let opaquePixels = 0;
  let totalSampled = 0;
  let mainColor: string | undefined;
  let maxCount = 0;

  for (let pixel = 0; pixel < totalPixels; pixel += step) {
    const offset = pixel * 4;
    const alpha = rgba[offset + 3];
    totalSampled += 1;
    if (alpha <= 20) continue;

    opaquePixels += 1;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const key = `${red},${green},${blue}`;
    const count = (colorCounts.get(key) ?? 0) + 1;
    colorCounts.set(key, count);
    if (count > maxCount) {
      maxCount = count;
      mainColor = key;
    }
  }

  if (opaquePixels === 0 || !mainColor) return { ...NEUTRAL_RESULT };
  const [mainRed, mainGreen, mainBlue] = mainColor.split(",").map(Number);
  let similarPixels = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += step) {
    const offset = pixel * 4;
    if (rgba[offset + 3] <= 20) continue;
    const distance = Math.hypot(
      rgba[offset] - mainRed,
      rgba[offset + 1] - mainGreen,
      rgba[offset + 2] - mainBlue,
    );
    if (distance < COLOR_DISTANCE_THRESHOLD) similarPixels += 1;
  }

  if (
    similarPixels / opaquePixels <= 0.85 ||
    (totalSampled - opaquePixels) / totalSampled <= 0.1 ||
    opaquePixels <= 20
  ) {
    return { ...NEUTRAL_RESULT };
  }

  const hex = [mainRed, mainGreen, mainBlue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("");
  return {
    isSimpleIcon: true,
    mainColor: `#${hex}`,
    isDark: (0.299 * mainRed + 0.587 * mainGreen + 0.114 * mainBlue) / 255 < 0.5,
    needsAdaptation: true,
  };
}

export function createRendererImageAnalyzer(): RendererImageAnalyzer {
  const cache = new Map<string, ImageAnalysisResult>();
  const failures: Partial<Record<ImageAnalysisFailure, number>> = {};
  const abortOperations = new Set<() => void>();
  let cacheHits = 0;
  let disposed = false;

  return {
    async analyze(input) {
      if (disposed) throw createAnalyzerDisposedError();
      let activeImage: HTMLImageElement | undefined;
      let controller: AbortController | undefined;
      let timedOut = false;
      let rejectTimeout!: (error: ImageAnalysisError) => void;
      let rejectDisposed!: (error: Error) => void;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const disposedPromise = new Promise<never>((_resolve, reject) => {
        rejectDisposed = reject;
      });
      void timeoutPromise.catch(() => undefined);
      void disposedPromise.catch(() => undefined);
      const abort = () => {
        controller?.abort();
        activeImage?.removeAttribute("src");
        rejectDisposed(createAnalyzerDisposedError());
      };
      abortOperations.add(abort);
      const timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        if (activeImage) activeImage.removeAttribute("src");
        rejectTimeout(new ImageAnalysisError("timeout"));
      }, MAX_ANALYSIS_MS);

      try {
        if (typeof input !== "string" || input.length === 0 || input.length > MAX_INPUT_CHARS) {
          throw new ImageAnalysisError(input?.length > MAX_INPUT_CHARS ? "byte_budget" : "unsupported_source");
        }

        const source = resolveImageSource(input);
        if (source.kind === "asset") {
          const cached = readCache(cache, `asset:${source.url.href}`);
          if (cached) {
            cacheHits += 1;
            return { ...cached };
          }
        }

        let bytes: Uint8Array;
        let mime: string;
        if (source.kind === "data") {
          ({ bytes, mime } = source);
        } else {
          controller = new AbortController();
          ({ bytes, mime } = await Promise.race([
            fetchBoundedAsset(source.url, controller.signal, source.cors),
            timeoutPromise,
            disposedPromise,
          ]));
        }

        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new ImageAnalysisError("byte_budget");
        }
        try {
          validateImagePayload(bytes, mime);
        } catch (error) {
          if (error instanceof ImagePayloadError) throw new ImageAnalysisError(error.reason);
          throw error;
        }

        const cacheKey = source.kind === "asset"
          ? `asset:${source.url.href}`
          : await Promise.race([dataCacheKey(bytes, mime), timeoutPromise, disposedPromise]);
        if (cacheKey) {
          const cached = readCache(cache, cacheKey);
          if (cached) {
            cacheHits += 1;
            return { ...cached };
          }
        }

        if (timedOut) throw new ImageAnalysisError("timeout");
        const blobBuffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(blobBuffer).set(bytes);
        const blob = new Blob([blobBuffer], { type: mime });
        const objectUrl = URL.createObjectURL(blob);
        try {
          const image = new Image();
          activeImage = image;
          image.decoding = "async";
          image.src = objectUrl;
          await Promise.race([image.decode(), timeoutPromise, disposedPromise]);
          if (timedOut) throw new ImageAnalysisError("timeout");

          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
            throw new ImageAnalysisError("pixel_budget");
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new ImageAnalysisError("canvas_unavailable");
          try {
            context.drawImage(image, 0, 0, width, height);
            const pixels = context.getImageData(0, 0, width, height).data;
            const result = analyzeRgbaPixels(pixels, width, height);
            if (cacheKey) writeCache(cache, cacheKey, result);
            return { ...result };
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        } finally {
          activeImage = undefined;
          URL.revokeObjectURL(objectUrl);
        }
      } catch (error) {
        if (disposed) throw createAnalyzerDisposedError();
        const reason = timedOut
          ? "timeout"
          : error instanceof ImageAnalysisError
            ? error.reason
            : "decode_failed";
        failures[reason] = (failures[reason] ?? 0) + 1;
        return { ...NEUTRAL_RESULT };
      } finally {
        clearTimeout(timer);
        abortOperations.delete(abort);
      }
    },
    snapshot() {
      return {
        cacheEntries: cache.size,
        cacheHits,
        failures: { ...failures },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cache.clear();
      for (const abort of [...abortOperations]) abort();
    },
  };
}

type ImageSource =
  | { kind: "asset"; url: URL; cors?: true }
  | { kind: "data"; bytes: Uint8Array; mime: string };

function resolveImageSource(input: string): ImageSource {
  if (input.startsWith("data:image/")) return decodeDataImage(input);
  if (typeof window === "undefined" || !window.location?.href) {
    throw new ImageAnalysisError("unsupported_source");
  }
  const isRelativeAsset = /^(?:\.\/|\/)?assets\//.test(input);
  const isAbsoluteUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  if (!isRelativeAsset && !isAbsoluteUrl) throw new ImageAnalysisError("unsupported_source");

  let pageUrl: URL;
  let url: URL;
  const appIcon = /^(?:atools-app-icon:\/\/localhost\/|https?:\/\/atools-app-icon\.localhost\/)[a-f0-9]{64}\.png$/.test(input);
  try {
    pageUrl = new URL(window.location.href);
    url = new URL(input, pageUrl);
  } catch {
    throw new ImageAnalysisError("unsupported_source");
  }
  if (appIcon) return { kind: "asset", url, cors: true };
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new ImageAnalysisError("unsupported_source");
  }
  const sameApplicationOrigin = url.protocol === pageUrl.protocol
    && url.host === pageUrl.host
    && url.protocol !== "file:"
    && (url.origin === pageUrl.origin || (url.origin === "null" && pageUrl.origin === "null"));
  if (!sameApplicationOrigin || !decodedPath.startsWith("/assets/")
    || decodedPath.includes("\\") || decodedPath.split("/").includes("..")
    || url.username || url.password) {
    throw new ImageAnalysisError("unsupported_source");
  }
  return { kind: "asset", url };
}

function decodeDataImage(input: string): { kind: "data"; bytes: Uint8Array; mime: string } {
  const match = DATA_IMAGE_PATTERN.exec(input);
  if (!match) {
    const declaredMime = /^data:image\/([^;,]+)/i.exec(input)?.[1]?.toLowerCase();
    throw new ImageAnalysisError(declaredMime && !["png", "svg", "svg+xml"].includes(declaredMime)
      ? "unsupported_source"
      : "invalid_data_image");
  }
  if (input.length > MAX_INPUT_CHARS) throw new ImageAnalysisError("byte_budget");
  try {
    const mime = normalizeMime(`image/${match[1]}`);
    const binary = atob(match[2]);
    if (binary.length === 0 || binary.length > MAX_IMAGE_BYTES) throw new ImageAnalysisError("byte_budget");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { kind: "data", bytes, mime };
  } catch (error) {
    if (error instanceof ImageAnalysisError) throw error;
    throw new ImageAnalysisError("invalid_data_image");
  }
}

async function fetchBoundedAsset(url: URL, signal: AbortSignal, cors?: true): Promise<{ bytes: Uint8Array; mime: string }> {
  let response: Response;
  try {
    response = await fetch(url.href, {
      cache: "force-cache",
      credentials: "omit",
      mode: cors ? "cors" : "same-origin",
      redirect: "error",
      signal,
    });
  } catch {
    throw new ImageAnalysisError(signal.aborted ? "timeout" : "decode_failed");
  }
  if (!response.ok || response.url && new URL(response.url).origin !== url.origin) {
    throw new ImageAnalysisError("decode_failed");
  }
  const mime = normalizeMime(response.headers.get("content-type")?.split(";")[0] ?? "");
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_IMAGE_BYTES) throw new ImageAnalysisError("byte_budget");
  if (!response.body) throw new ImageAnalysisError("decode_failed");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ImageAnalysisError("byte_budget");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ImageAnalysisError) throw error;
    throw new ImageAnalysisError(signal.aborted ? "timeout" : "decode_failed");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mime };
}

function normalizeMime(value: string): string {
  const mime = value.toLowerCase().trim();
  if (mime === "image/svg") return "image/svg+xml";
  if (mime === "image/png" || mime === "image/svg+xml") {
    return mime;
  }
  throw new ImageAnalysisError("unsupported_source");
}

async function dataCacheKey(bytes: Uint8Array, mime: string): Promise<string | undefined> {
  if (typeof crypto === "undefined" || !crypto.subtle) return undefined;
  try {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
    const hex = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
    return `data:${mime}:${hex}`;
  } catch {
    return undefined;
  }
}

function readCache(cache: Map<string, ImageAnalysisResult>, key: string): ImageAnalysisResult | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeCache(cache: Map<string, ImageAnalysisResult>, key: string, value: ImageAnalysisResult): void {
  cache.delete(key);
  cache.set(key, { ...value });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

class ImageAnalysisError extends Error {
  constructor(readonly reason: ImageAnalysisFailure) {
    super(reason);
    this.name = "ImageAnalysisError";
  }
}

function createAnalyzerDisposedError(): Error {
  const error = new Error("ATools image analyzer has been disposed");
  error.name = "AbortError";
  Object.assign(error, { code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
  return error;
}
