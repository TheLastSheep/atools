import { installNodeBufferReaders } from "./nodeBufferNumbers";

/** Local byte operations only. This bounded subset never opens a Node session. */
export function createBrowserBuffer(installReaders = installNodeBufferReaders) {
  const maximum = 16 * 1024 * 1024;
  function range(size: number) {
    if (!Number.isFinite(size) || size < 0 || size > maximum) throw new RangeError("Buffer exceeds the 16 MiB local byte budget");
    return Math.trunc(size);
  }
  function encoding(value: unknown = "utf8"): string {
    const name = typeof value === "string" ? value.toLowerCase() : "";
    const aliases: Record<string, string> = { "utf-8": "utf8", binary: "latin1", "utf-16le": "utf16le", ucs2: "utf16le", "ucs-2": "utf16le" };
    const result = aliases[name] || name;
    if (["utf8", "hex", "base64", "base64url", "ascii", "latin1", "utf16le"].includes(result)) return result;
    throw Object.assign(new TypeError("Unknown Buffer encoding"), { code: "ERR_UNKNOWN_ENCODING" });
  }
  function base64(bytes: Uint8Array): string {
    let binary = "";
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  }
  function utf8Size(text: string) {
    let count = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) count++;
      else if (code < 0x800) count += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { count += 4; index++; }
      else count += 3;
    }
    return count;
  }
  function stringBytes(text: string, name: string): Uint8Array {
    if (name === "utf8") { range(utf8Size(text)); return new TextEncoder().encode(text); }
    if (name === "hex") {
      const bytes = new Uint8Array(range(Math.floor(text.length / 2)));
      let count = 0;
      for (let offset = 0; offset + 1 < text.length; offset += 2) {
        const pair = text.slice(offset, offset + 2);
        if (!/^[0-9a-f]{2}$/i.test(pair)) break;
        bytes[count++] = parseInt(pair, 16);
      }
      return bytes.subarray(0, count);
    }
    if (name === "base64" || name === "base64url") {
      // Node accepts whitespace, URL-safe alphabets and incomplete final groups.
      range(Math.floor(text.length * 3 / 4));
      const narrowed = text.replace(/[^\x00-\xff]/g, character => String.fromCharCode(character.charCodeAt(0) & 255));
      let clean = narrowed.split("=", 1)[0].replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
      if (clean.length % 4 === 1) clean = clean.slice(0, -1);
      const binary = atob(clean + "=".repeat((4 - clean.length % 4) % 4));
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
    const wide = name === "utf16le";
    const bytes = new Uint8Array(range(text.length * (wide ? 2 : 1)));
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      bytes[index * (wide ? 2 : 1)] = code & 255;
      if (wide) bytes[index * 2 + 1] = code >>> 8;
    }
    return bytes;
  }
  class ByteBuffer extends Uint8Array {
    constructor(value: number | ArrayBuffer | ArrayLike<number> = 0, offset?: number, length?: number) {
      if (typeof value === "number") super(range(value));
      else {
        let bytes: number | undefined;
        try { bytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value); } catch { /* Array-like copy below. */ }
        if (bytes !== undefined) {
          range(length === undefined ? bytes - (Number(offset) || 0) : Number(length));
          super(value as ArrayBuffer, offset, length);
        } else { range(Number((value as ArrayLike<number>).length) || 0); super(value as ArrayLike<number>); }
      }
    }
    toString(selected: unknown = "utf8", start = 0, end = this.length): string {
      if (start <= 0) start = 0;
      else if (start >= this.length) return "";
      else start = Math.trunc(start) || 0;
      end = end === undefined || end > this.length ? this.length : Math.trunc(end) || 0;
      if (end <= start) return "";
      const bytes = this.subarray(start, end), name = encoding(selected);
      if (name === "base64") return base64(bytes);
      if (name === "base64url") return base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (name === "hex") {
        let result = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) result += Array.from(bytes.subarray(offset, offset + 8192), value => value.toString(16).padStart(2, "0")).join("");
        return result;
      }
      if (name === "utf8") return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      let result = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        const codes: number[] = [];
        for (let index = offset; index < Math.min(offset + 8192, bytes.length); index += name === "utf16le" ? 2 : 1) {
          if (name !== "utf16le") codes.push(name === "ascii" ? bytes[index] & 127 : bytes[index]);
          else if (index + 1 < bytes.length) codes.push(bytes[index] | bytes[index + 1] << 8);
        }
        result += String.fromCharCode(...codes);
      }
      return result;
    }
    toJSON() { return { type: "Buffer", data: Array.from(this) }; }
    slice(start?: number, end?: number) { return this.subarray(start, end); }
    equals(other: Uint8Array) { return this.length === other.length && this.every((value, index) => value === other[index]); }
  }
  installReaders(ByteBuffer.prototype);
  function from(value: unknown, selected?: unknown, length?: number): ByteBuffer {
    if (typeof value === "string") {
      const bytes = stringBytes(value, encoding(typeof selected !== "string" || selected === "" ? "utf8" : selected));
      return new ByteBuffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
    }
    if (typeof value === "number" || value === null || value === undefined) throw new TypeError("Buffer.from expects a string, byte array or ArrayBuffer");
    let bytes: number | undefined;
    try { bytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value); } catch { /* Array-like below. */ }
    if (bytes !== undefined) return new ByteBuffer(value as ArrayBuffer, selected as number | undefined, length);
    if (typeof value === "object" && (value as { type?: unknown }).type === "Buffer") value = (value as { data?: unknown }).data;
    if (value && typeof (value as ArrayLike<number>).length === "number") return new ByteBuffer(value as ArrayLike<number>);
    throw new TypeError("Unsupported Buffer.from input");
  }
  const BufferCtor = function (value: unknown, selected?: unknown, length?: number) {
    return typeof value === "number" ? new ByteBuffer(value) : from(value, selected, length);
  } as unknown as typeof ByteBuffer & {
    from: typeof from;
    alloc: (size: number, fill?: number | string | Uint8Array, encoding?: string) => ByteBuffer;
    allocUnsafe: (size: number) => ByteBuffer;
    allocUnsafeSlow: (size: number) => ByteBuffer;
    concat: (list: Uint8Array[], totalLength?: number) => ByteBuffer;
    isBuffer: (value: unknown) => boolean;
    isEncoding: (value: unknown) => boolean;
    byteLength: (value: string | ArrayBuffer | ArrayBufferView, encoding?: string) => number;
  };
  BufferCtor.prototype = ByteBuffer.prototype;
  Object.setPrototypeOf(BufferCtor, Uint8Array);
  Object.assign(BufferCtor, {
    from,
    isBuffer: (value: unknown) => value instanceof ByteBuffer,
    isEncoding: (value: unknown) => { if (typeof value !== "string" || !value) return false; try { encoding(value); return true; } catch { return false; } },
    alloc(size: number, fill: number | string | Uint8Array = 0, selected = "utf8") {
      if (typeof size !== "number") throw new TypeError("Buffer size must be a number");
      const bytes = new ByteBuffer(size);
      if (typeof fill === "number") { bytes.fill(fill); return bytes; }
      const pattern = typeof fill === "string" ? from(fill, selected) : fill;
      if (!ArrayBuffer.isView(pattern)) throw new TypeError("Invalid Buffer fill");
      if (pattern.length) for (let index = 0; index < bytes.length; index++) bytes[index] = pattern[index % pattern.length];
      return bytes;
    },
    allocUnsafe: (size: number) => new ByteBuffer(size),
    allocUnsafeSlow: (size: number) => new ByteBuffer(size),
    concat(list: Uint8Array[], totalLength?: number) {
      if (!Array.isArray(list) || list.some(value => !ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== "[object Uint8Array]")) throw new TypeError("Buffer.concat expects byte arrays");
      const size = range(totalLength === undefined ? list.reduce((sum, value) => sum + value.length, 0) : totalLength);
      const result = new ByteBuffer(size); let offset = 0;
      for (const item of list) { const count = Math.min(item.length, size - offset); result.set(item.subarray(0, count), offset); offset += count; if (offset === size) break; }
      return result;
    },
    byteLength(value: string | ArrayBuffer | ArrayBufferView, selected = "utf8") {
      if (typeof value !== "string") {
        if (ArrayBuffer.isView(value)) return value.byteLength;
        return Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value);
      }
      const name = encoding(selected);
      if (name === "hex") return Math.floor(value.length / 2);
      if (name === "base64" || name === "base64url") {
        // Node estimates from the input length and removes at most two padding bytes.
        let length = value.length;
        if (value.charCodeAt(length - 1) === 61) length--;
        if (value.charCodeAt(length - 1) === 61) length--;
        return Math.floor(Math.max(length, 0) * 3 / 4);
      }
      return name === "utf8" ? utf8Size(value) : value.length * (name === "utf16le" ? 2 : 1);
    },
  });
  return BufferCtor;
}

/** Self-contained factory expression shared by injected page and RPC codecs. */
export function browserBufferFactoryScript(): string {
  return `(() => (${createBrowserBuffer.toString()})(${installNodeBufferReaders.toString()}))`;
}
