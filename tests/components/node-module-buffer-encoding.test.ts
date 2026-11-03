import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer as NativeBuffer } from "node:buffer";
import { createNodeModuleCodec } from "../../src/lib/nodeModuleValues";

afterEach(() => vi.unstubAllGlobals());
function copy(bytes: Uint8Array): any {
  vi.stubGlobal("Buffer", undefined);
  const codec = createNodeModuleCodec({ handle: () => {}, promise: () => Promise.resolve(),
    callback: () => "", existingHandle: () => undefined });
  return codec.decode({ kind: "buffer", data: NativeBuffer.from(bytes).toString("base64") });
}

describe("Browser Buffer string encodings match real Node", () => {
  const encodings = ["base64url", "BASE64URL", "base64", "hex", "HEX", "utf8", "UTF-8",
    "ascii", "ASCII", "latin1", "binary", "utf16le", "utf-16le", "ucs2", "ucs-2"] as const;
  const fixtures = [[], [0xfb], [0xfb, 0xff], [0xfb, 0xff, 0xfe], [0xef, 0xbb, 0xbf, 0x41],
    [0, 0x7f, 0x80, 0xff], [0x00, 0xd8, 0x41, 0, 0xff], Array.from({ length: 16401 }, (_, index) => index % 256)];
  it.each(encodings)("matches %s including invalid Unicode, BOM, odd byte lengths and chunk boundaries", (encoding) => {
    for (const fixture of fixtures) {
      const native = NativeBuffer.from(fixture), browser = copy(native);
      expect(browser.toString(encoding)).toBe(native.toString(encoding as BufferEncoding));
      for (const [start, end] of [[-4, 2], [0, -1], [1.5, 4.9], [NaN, Infinity], [Infinity, Infinity], [1, 0], [2, 7]]) {
        expect(browser.toString(encoding, start, end)).toBe(native.toString(encoding as BufferEncoding, start, end));
      }
    }
  });
  it("supports original webhook route tokens without padding or URL-unsafe symbols", () => {
    const bytes = NativeBuffer.from([0xfb, 0xff, 0xfe, 0xfa]);
    expect(copy(bytes).toString("base64url")).toBe("-__--g");
  });
});
