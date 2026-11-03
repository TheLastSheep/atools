export type ClipboardHistoryType = "text" | "image" | "file";

export type ClipboardHistoryItem =
  | { id: string; type: "text"; timestamp: number; preview: string; content: string }
  | { id: string; type: "image"; timestamp: number; preview: string; imagePath: string; content: string; byteSize?: number }
  | { id: string; type: "file"; timestamp: number; preview: string; files: Array<{ path: string; name?: string }>; content: string[] };

export type ClipboardHistoryFailure = (code: string, message: string) => Error;

export type ClipboardHistoryCodec = {
  validId: (value: unknown, type?: ClipboardHistoryType) => value is string;
  validateItem: (value: unknown, allowMissingTextPreview?: boolean) => ClipboardHistoryItem;
};

export type ClipboardHistoryCodecFactory = (failure: ClipboardHistoryFailure) => ClipboardHistoryCodec;

/** Validates and canonicalizes untrusted records returned through the clipboard history host. */
export function createClipboardHistoryCodec(failure: ClipboardHistoryFailure): ClipboardHistoryCodec {
  const maxTextBytes = 256 * 1024;
  const maxPathBytes = 8192;
  const maxFiles = 20;
  const maxFilePathBytes = 64 * 1024;
  const maxPreviewScalars = 256;
  const encoder = new TextEncoder();

  function invalid(message: string): never {
    throw failure("ERR_ATOOLS_CLIPBOARD_RESPONSE", message);
  }

  function byteLength(value: string): number {
    return encoder.encode(value).length;
  }

  function previewFor(content: string): string {
    return Array.from(content).slice(0, maxPreviewScalars).join("");
  }

  function validId(value: unknown, type?: ClipboardHistoryType): value is string {
    if (typeof value !== "string") return false;
    if (type === "text") return /^clip-[0-9a-f]{16}$/.test(value);
    if (type === "image") return /^clip-image-[0-9a-f]{16}$/.test(value);
    if (type === "file") return /^clip-file-[0-9a-f]{16}$/.test(value);
    return /^clip-(?:[0-9a-f]{16}|image-[0-9a-f]{16}|file-[0-9a-f]{16})$/.test(value);
  }

  function validLocalPath(value: unknown): value is string {
    if (typeof value !== "string" || !value || value.includes("\0") || byteLength(value) > maxPathBytes
      || /^data:/i.test(value)) return false;
    return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  }

  function validatePreview(value: unknown): value is string {
    return typeof value === "string" && Array.from(value).length <= maxPreviewScalars;
  }

  function hasOnlyKeys(row: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(row).every((key) => allowed.includes(key));
  }

  function validateTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
  }

  function validateText(row: Record<string, unknown>, allowMissingPreview: boolean): ClipboardHistoryItem {
    if (!validId(row.id, "text") || row.type !== "text" || !validateTimestamp(row.timestamp)
      || typeof row.content !== "string" || byteLength(row.content) > maxTextBytes) {
      return invalid("Unsupported or oversized clipboard text history item");
    }
    const expectedPreview = previewFor(row.content);
    const preview = row.preview === undefined && allowMissingPreview ? expectedPreview : row.preview;
    if (!validatePreview(preview) || preview !== expectedPreview) {
      return invalid("Clipboard text preview does not match its content");
    }
    return { id: row.id, type: "text", timestamp: row.timestamp, preview, content: row.content };
  }

  function validateImage(row: Record<string, unknown>): ClipboardHistoryItem {
    if (!hasOnlyKeys(row, ["id", "type", "timestamp", "preview", "imagePath", "content", "byteSize"])
      || !validId(row.id, "image") || row.type !== "image" || !validateTimestamp(row.timestamp)
      || !validatePreview(row.preview) || !validLocalPath(row.imagePath) || row.content !== row.imagePath
      || (row.byteSize !== undefined && (!Number.isSafeInteger(row.byteSize) || Number(row.byteSize) < 0))) {
      return invalid("Unsupported clipboard image history item");
    }
    return {
      id: row.id,
      type: "image",
      timestamp: row.timestamp,
      preview: row.preview,
      imagePath: row.imagePath,
      content: row.imagePath,
      ...(row.byteSize === undefined ? {} : { byteSize: Number(row.byteSize) }),
    };
  }

  function validateFile(row: Record<string, unknown>): ClipboardHistoryItem {
    if (!hasOnlyKeys(row, ["id", "type", "timestamp", "preview", "files", "content"])
      || !validId(row.id, "file") || row.type !== "file" || !validateTimestamp(row.timestamp)
      || !validatePreview(row.preview) || !Array.isArray(row.files) || row.files.length < 1 || row.files.length > maxFiles
      || !Array.isArray(row.content) || row.content.length !== row.files.length) {
      return invalid("Unsupported clipboard file history item");
    }
    const files: Array<{ path: string; name?: string }> = [];
    let totalPathBytes = 0;
    for (let index = 0; index < row.files.length; index += 1) {
      const candidate = row.files[index];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return invalid("Clipboard history file entry must be an object");
      }
      const file = candidate as Record<string, unknown>;
      if (Object.keys(file).some((key) => key !== "path" && key !== "name") || !validLocalPath(file.path)
        || (file.name !== undefined && (typeof file.name !== "string" || byteLength(file.name) > maxPathBytes))) {
        return invalid("Clipboard history file entry must contain a bounded local path and optional name");
      }
      if (row.content[index] !== file.path) return invalid("Clipboard file content paths do not match file entries");
      totalPathBytes += byteLength(file.path);
      files.push({ path: file.path, ...(file.name === undefined ? {} : { name: file.name }) });
    }
    if (totalPathBytes > maxFilePathBytes) return invalid("Clipboard file paths exceed 64 KiB");
    return {
      id: row.id,
      type: "file",
      timestamp: row.timestamp,
      preview: row.preview,
      files,
      content: files.map((file) => file.path),
    };
  }

  function validateItem(value: unknown, allowMissingTextPreview = false): ClipboardHistoryItem {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalid("Invalid clipboard history item");
    }
    const row = value as Record<string, unknown>;
    if (row.type === "text") return validateText(row, allowMissingTextPreview);
    if (row.type === "image") return validateImage(row);
    if (row.type === "file") return validateFile(row);
    return invalid("Unsupported clipboard history item type");
  }

  return { validId, validateItem };
}
