export type PluginFileDropEntry = {
  name: string; path: string; type: string; lastModified: number; size: number; offset: number;
};
export type PluginFileDropPacket = {
  requestId: string; leaseId: string; expiresAt: number; files: PluginFileDropEntry[]; bytes: Uint8Array<ArrayBuffer>;
};

/** Strict bounded parser for native ATFD v1. Offsets address only the raw payload tail. */
export function parsePluginFileDropPacket(value: ArrayBuffer, expectedRequestId: string, now = Date.now()): PluginFileDropPacket {
  const MAX_HEADER = 128 * 1024, MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024;
  const MAX_PACKET = 9 + MAX_HEADER + MAX_TOTAL;
  const fail = (): never => { throw new Error("ERR_ATOOLS_FILE_DROP_PACKET"); };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!(value instanceof ArrayBuffer) || value.byteLength < 9 || value.byteLength > MAX_PACKET) return fail();
  const data = new Uint8Array(value), view = new DataView(value);
  if (data[0] !== 65 || data[1] !== 84 || data[2] !== 70 || data[3] !== 68 || data[4] !== 1) return fail();
  const headerLength = view.getUint32(5, true);
  if (headerLength < 2 || headerLength > MAX_HEADER || 9 + headerLength > value.byteLength) return fail();
  let header: unknown;
  try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(9, 9 + headerLength))); }
  catch { return fail(); }
  if (!header || typeof header !== "object" || Array.isArray(header)) return fail();
  const record = header as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "expiresAt,files,leaseId,requestId"
    || typeof record.requestId !== "string" || !uuid.test(record.requestId) || record.requestId !== expectedRequestId
    || typeof record.leaseId !== "string" || !uuid.test(record.leaseId)
    || !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) <= now
    || Number(record.expiresAt) > now + 120_000 || !Array.isArray(record.files)
    || record.files.length < 1 || record.files.length > 16) return fail();
  const raw = data.subarray(9 + headerLength), files: PluginFileDropEntry[] = [];
  let offset = 0;
  for (const item of record.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail();
    const file = item as Record<string, unknown>;
    if (Object.keys(file).sort().join(",") !== "lastModified,name,offset,path,size,type"
      || typeof file.name !== "string" || !file.name || file.name.length > 255 || /[\\/\0\r\n]/.test(file.name)
      || typeof file.path !== "string" || file.path.length < 2 || file.path.length > 8192 || file.path.includes("\0")
      || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(file.path))
      || typeof file.type !== "string" || file.type.length > 255 || /[\0\r\n]/.test(file.type)
      || !Number.isSafeInteger(file.lastModified) || Number(file.lastModified) < 0
      || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > MAX_FILE
      || !Number.isSafeInteger(file.offset) || Number(file.offset) !== offset) return fail();
    offset += Number(file.size);
    if (offset > MAX_TOTAL || offset > raw.byteLength) return fail();
    files.push({ name: file.name, path: file.path, type: file.type, lastModified: Number(file.lastModified),
      size: Number(file.size), offset: Number(file.offset) });
  }
  if (offset !== raw.byteLength) return fail();
  return { requestId: record.requestId, leaseId: record.leaseId, expiresAt: Number(record.expiresAt), files, bytes: raw };
}

/** Accept only the verified raw Tauri ArrayBuffer transport, never structured fallbacks. */
export function exactPluginFileDropBuffer(value: unknown): ArrayBuffer {
  const max = 9 + 128 * 1024 + 8 * 1024 * 1024;
  if (value instanceof ArrayBuffer) {
    if (value.byteLength < 9 || value.byteLength > max) throw new Error("ERR_ATOOLS_FILE_DROP_PACKET_SIZE");
    return value;
  }
  throw new Error("ERR_ATOOLS_FILE_DROP_BINARY_UNAVAILABLE");
}
