export type ImagePayloadFailure = "invalid_data_image" | "unsupported_source" | "pixel_budget";

export class ImagePayloadError extends Error {
  constructor(readonly reason: ImagePayloadFailure) {
    super(reason);
    this.name = "ImagePayloadError";
  }
}

const DEFAULT_MAX_PIXELS = 2 * 1024 * 1024;

/** Rejects unsafe SVG content and declared dimensions before browser decode. */
export function validateImagePayload(bytes: Uint8Array, mime: string): void {
  if (mime === "image/svg+xml") {
    const dimensions = validateSvgPayload(bytes);
    validatePixelBudget(dimensions[0], dimensions[1]);
    return;
  }
  if (mime !== "image/png") throw new ImagePayloadError("unsupported_source");
  if (bytes.length < 24 || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
    || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
    throw new ImagePayloadError("invalid_data_image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13) throw new ImagePayloadError("invalid_data_image");
  validatePixelBudget(view.getUint32(16, false), view.getUint32(20, false));
}

function validateSvgPayload(bytes: Uint8Array): [number, number] {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImagePayloadError("invalid_data_image");
  }
  source = decodeXmlEntitiesForSafety(source);
  const unsafe = /<!DOCTYPE|<!ENTITY|<\?(?:xml-stylesheet)\b|<(?:script|foreignObject)\b|\bon[a-z]+\s*=|@import\b|url\s*\(\s*(?!#)|(?:href|src)\s*=\s*(["'])(?!#)/i;
  if (unsafe.test(source)) throw new ImagePayloadError("unsupported_source");

  const svg = /<svg\b([^>]*)>/i.exec(source)?.[1];
  if (!svg) throw new ImagePayloadError("invalid_data_image");
  const width = readSvgLength(readSvgAttribute(svg, "width"));
  const height = readSvgLength(readSvgAttribute(svg, "height"));
  const viewBox = readSvgViewBox(readSvgAttribute(svg, "viewBox"));
  if (width && height) return [width, height];
  if (viewBox && width) return [width, width * viewBox[1] / viewBox[0]];
  if (viewBox && height) return [height * viewBox[0] / viewBox[1], height];
  if (viewBox) return viewBox;
  throw new ImagePayloadError("unsupported_source");
}

function readSvgAttribute(tag: string, name: string): string | undefined {
  const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag)?.[2];
  return value;
}

function readSvgLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)(px|in|cm|mm|pt|pc)?\s*$/i.exec(value);
  if (!match) return undefined;
  const factor = ({ px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16 } as Record<string, number>)[(match[2] ?? "px").toLowerCase()];
  return Number(match[1]) * factor;
}

function readSvgViewBox(value: string | undefined): [number, number] | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isFinite) || parts[2] <= 0 || parts[3] <= 0) return undefined;
  return [parts[2], parts[3]];
}

function decodeXmlEntitiesForSafety(source: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
  try {
    return source.replace(/&#(?:x([\da-f]+)|(\d+));|&(amp|lt|gt|quot|apos);/gi, (_entity, hex, decimal, name) => {
      if (name) return named[name];
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Error("Invalid XML character reference");
      }
      return String.fromCodePoint(codePoint);
    });
  } catch {
    throw new ImagePayloadError("invalid_data_image");
  }
}

function validatePixelBudget(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
    || width * height > DEFAULT_MAX_PIXELS) {
    throw new ImagePayloadError("pixel_budget");
  }
}
