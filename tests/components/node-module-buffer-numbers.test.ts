import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer as NativeBuffer } from "node:buffer";
import { createNodeModuleCodec, nodeModuleCodecScript } from "../../src/lib/nodeModuleValues";

afterEach(() => vi.unstubAllGlobals());
const hooks = { handle: () => {}, promise: () => Promise.resolve(), callback: () => "", existingHandle: () => undefined };
function copy(bytes: Uint8Array, serialized = false): any {
  vi.stubGlobal("Buffer", undefined);
  try {
    const codec = serialized ? new Function(`return ${nodeModuleCodecScript()}`)()(hooks) : createNodeModuleCodec(hooks);
    return codec.decode({ kind: "buffer", data: NativeBuffer.from(bytes).toString("base64") });
  } finally { vi.unstubAllGlobals(); }
}
function observe(buffer: any, method: string, offset?: unknown) {
  try { return { value: buffer[method](offset) }; }
  catch (error) { return { name: (error as Error).name, code: (error as any).code }; }
}
const methods = ["readUInt8", "readUint8", "readInt8", ...["UInt16", "Uint16", "Int16", "UInt32", "Uint32", "Int32", "Float", "Double", "BigUInt64", "BigUint64", "BigInt64"]
  .flatMap(name => ["LE", "BE"].map(endian => `read${name}${endian}`))];

describe("Browser Buffer numeric reads match real Node byte copies", () => {
  it.each(methods)("matches %s values and offset errors including short buffers", method => {
    for (const data of [[], [0xff], [1, 2, 3], Array.from({ length: 21 }, (_, index) => (index * 31 + 0x80) % 256)]) {
      const native = NativeBuffer.from(data), browser = copy(native);
      for (const offset of [undefined, 0, 1, 4, 13, data.length, -1, 0.5, NaN, Infinity, -Infinity, null, "0", true, 0n, {}]) {
        expect(observe(browser, method, offset), `length=${data.length} offset=${String(offset)}`).toEqual(observe(native, method, offset));
      }
    }
  });
  it("uses current bytes and subarray offsets without extra communication", () => {
    const native = NativeBuffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), browser = copy(native);
    expect(browser.subarray(2, 8).readUInt32BE(1)).toBe(native.subarray(2, 8).readUInt32BE(1));
    browser[3] = native[3] = 0xff;
    expect(browser.readUInt32BE(1)).toBe(native.readUInt32BE(1));
    for (const value of [NaN, Infinity, -Infinity, -0, 0.125]) {
      native.writeDoubleLE(value);
      expect(copy(native).readDoubleLE()).toBe(native.readDoubleLE());
    }
  });
  it("serializes the numeric reader dependency for opaque WebKit frames and parses a PNG header", () => {
    const png = NativeBuffer.alloc(24);
    png.write("89504e470d0a1a0a", 0, "hex"); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
    const browser = copy(png, true);
    expect([browser.readUInt32BE(16), browser.readUInt32BE(20)]).toEqual([1920, 1080]);
  });
});
