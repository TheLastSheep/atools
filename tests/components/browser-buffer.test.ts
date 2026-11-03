import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer as NativeBuffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { createBrowserBuffer, browserBufferFactoryScript } from "../../src/lib/browserBuffer";
import { base64ToBytes, bytesToBase64 } from "../../ZTools-plugins/plugins/developer-codec-tools/codec.js";

afterEach(() => vi.unstubAllGlobals());
const LocalBuffer = createBrowserBuffer();

describe("bounded local Buffer byte operations", () => {
  it.each(["utf8", "utf-8", "base64", "base64url", "hex", "ascii", "latin1", "binary", "utf16le", "ucs2"])("matches real Node for %s input and output", selected => {
    for (const text of ["", "Hello, 世界🙂", "\ufeffA\ud800", "00ff12ab5", "001zff", " Zm9v\nYmFy==", "-_8=", "a", "a=bc", "Zm$9v"]) {
      const native = NativeBuffer.from(text, selected as BufferEncoding);
      const local = LocalBuffer.from(text, selected);
      expect(Array.from(local)).toEqual(Array.from(native));
      for (const output of ["utf8", "hex", "base64", "base64url", "latin1", "ascii", "utf16le"]) {
        expect(local.toString(output)).toBe(native.toString(output as BufferEncoding));
      }
    }
  });

  it("copies typed arrays, shares ArrayBuffer views, preserves byte offsets and JSON representation", () => {
    const source = Uint8Array.from([1, 2, 3, 4]);
    const copy = LocalBuffer.from(source), view = LocalBuffer.from(source.buffer, 1, 2);
    source[1] = 9;
    expect(Array.from(copy)).toEqual([1, 2, 3, 4]);
    expect(Array.from(view)).toEqual([9, 3]);
    expect(view.toJSON()).toEqual({ type: "Buffer", data: [9, 3] });
    const slice = copy.slice(1, 3); slice[0] = 8;
    expect(copy[1]).toBe(8);
    expect(LocalBuffer.isBuffer(copy)).toBe(true);
    expect(LocalBuffer.isBuffer(new Uint8Array(2))).toBe(false);
    expect(Array.from(LocalBuffer.from(copy.toJSON()))).toEqual(Array.from(copy));
  });

  it("matches Node's Base64 length estimate including whitespace and malformed padding", () => {
    for (const text of ["Zm9v\nYmFy", " Zm9v ", "Zm$9v", "=", "==", "===", "====", "Zm9v====", "a===", "-_8="]) {
      for (const encoding of ["base64", "base64url"] as const) {
        expect(LocalBuffer.byteLength(text, encoding)).toBe(NativeBuffer.byteLength(text, encoding));
      }
    }
  });

  it("supports bounded alloc/fill/concat and numeric reads without any RPC", () => {
    const filled = LocalBuffer.alloc(7, "ab");
    expect(filled.toString()).toBe(NativeBuffer.alloc(7, "ab").toString());
    const bytes = LocalBuffer.concat([LocalBuffer.from("0102", "hex"), new Uint8Array([3])], 5);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 0, 0]);
    expect((bytes as any).readUInt16BE(0)).toBe(258);
    expect(bytes.equals(LocalBuffer.from([1, 2, 3, 0, 0]))).toBe(true);
    const crossRealm = runInNewContext("new Uint8Array([4,5])");
    expect(Array.from(LocalBuffer.concat([crossRealm]))).toEqual([4, 5]);
  });

  it("rejects oversized inputs before allocation/index access and reports unsupported encodings", () => {
    const index = vi.fn(() => { throw Error("must not read"); });
    const large = { length: 16 * 1024 * 1024 + 1, get 0() { return index(); } };
    expect(() => LocalBuffer.from(large)).toThrow(RangeError);
    expect(index).not.toHaveBeenCalled();
    expect(() => LocalBuffer.alloc(16 * 1024 * 1024 + 1)).toThrow(RangeError);
    expect(() => LocalBuffer.from("x", "unknown")).toThrow(TypeError);
    expect(() => LocalBuffer.from(1)).toThrow(TypeError);
    expect(LocalBuffer.isEncoding(undefined)).toBe(false);
    expect(LocalBuffer.isEncoding("base64url")).toBe(true);
    expect(LocalBuffer.byteLength("🙂世界")).toBe(NativeBuffer.byteLength("🙂世界"));
  });

  it("executes the unchanged original codec Base64 branch correctly with local Buffer present", () => {
    vi.stubGlobal("Buffer", LocalBuffer);
    for (const text of ["", "ATools 编码🙂", "\ufeff中文\n第二行"]) {
      const bytes = new TextEncoder().encode(text);
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(NativeBuffer.from(bytes).toString("base64"));
      expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
    }
    expect(() => base64ToBytes("not valid!?")).toThrow();
  });

  it("serializes the same factory with all dependencies into an isolated browser-like realm", () => {
    const factory = runInNewContext(browserBufferFactoryScript(), { TextEncoder, TextDecoder, btoa, atob });
    const Buffer = factory();
    expect(Buffer.from("中文🙂").toString("base64")).toBe(NativeBuffer.from("中文🙂").toString("base64"));
    expect(Buffer.from("-_8", "base64").toString("hex")).toBe("fbff");
    expect(Buffer.alloc(4).readUInt32BE(0)).toBe(0);
  });
});
