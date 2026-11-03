import { exactEventRecord } from "./safeEventRecord";
import { invalidRendererArgument, invalidRendererResponse } from "./errors";

export type RendererCopiedFile = {
  path: string;
  name: string;
  isFile: boolean;
  isDirectory: boolean;
};

export type RendererLastCopiedContent =
  | { type: "text"; data: string; timestamp: number }
  | { type: "image"; data: string; timestamp: number }
  | { type: "file"; data: RendererCopiedFile[]; timestamp: number };

export type RendererClipboardReader = (timeLimit?: number) => Promise<RendererLastCopiedContent | null>;

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_IMAGE_URL_LENGTH = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 10 * 1024 * 1024;
const MAX_FILES = 1024;

type NativeClipboardReader = (args: { timeLimit: number | null }) => Promise<unknown>;

export function createRendererClipboardReader(
  readNative: NativeClipboardReader,
  ensureActive: () => void,
): RendererClipboardReader {
  return async (timeLimit) => {
    ensureActive();
    const normalizedLimit = normalizeTimeLimit(timeLimit);
    const value = await readNative({ timeLimit: normalizedLimit });
    ensureActive();
    return validateClipboardReply(value);
  };
}

function normalizeTimeLimit(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw invalidRendererArgument("getLastCopiedContent timeLimit");
  }
  return value > 0 ? value : null;
}

function validateClipboardReply(value: unknown): RendererLastCopiedContent | null {
  if (value === null) return null;
  try {
    const { type, data, timestamp } = exactEventRecord(value, ["type", "data", "timestamp"]);
    if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0) throw null;
    const valid = type === "file"
      ? Array.isArray(data) && data.length >= 1 && data.length <= MAX_FILES
      : typeof data === "string" && (type === "text"
        ? data.length <= MAX_TEXT_LENGTH
        : type === "image" && data.length <= MAX_IMAGE_URL_LENGTH && data.startsWith(PNG_DATA_URL_PREFIX));
    if (!valid) throw null;
    return { type, data, timestamp } as RendererLastCopiedContent;
  } catch {
    throw invalidRendererResponse("getLastCopiedContent");
  }
}
