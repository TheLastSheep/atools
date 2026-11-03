import { describe, expect, it } from "vitest";
import { createNodeModuleCodec } from "../../src/lib/nodeModuleValues";
import type { EncodedNodeValue } from "../../src/lib/nodeModuleProtocol";

const value = (input: number | string): EncodedNodeValue => ({ kind: "value", value: input });
const bigint = (input: number): EncodedNodeValue => ({ kind: "bigint", value: String(input) });
const codec = () => createNodeModuleCodec({
  handle: () => { throw Error("No remote handle required"); },
  promise: () => { throw Error("No promise required"); },
  callback: () => { throw Error("No callbacks required"); }, existingHandle: () => undefined,
});

describe("Native filesystem value copies", () => {
  it.each([false, true])("supports mutable local Stats predicates and dates (BigInt=%s)", (big) => {
    const wire: EncodedNodeValue = { kind: "fsStats", properties: {
      mode: big ? bigint(0x81a4) : value(0x81a4), size: big ? bigint(4) : value(4),
      mtimeMs: big ? bigint(1234) : value(1234),
    } };
    const values = codec(), stats = values.decode(wire);
    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.mtime.getTime()).toBe(1234);
    expect(stats.mtime).toBe(stats.mtime);
    stats.mode = big ? 0x4000n : 0x4000;
    expect(stats.isFile()).toBe(false);
    expect(stats.isDirectory()).toBe(true);
    const encoded = values.encode(stats);
    expect(encoded.kind).toBe("fsStats");
    expect(values.decode(encoded).isDirectory()).toBe(true);
  });

  it.each([[1,"isFile"],[2,"isDirectory"],[3,"isSymbolicLink"],[4,"isFIFO"],
    [5,"isSocket"],[6,"isCharacterDevice"],[7,"isBlockDevice"]] as const)("preserves native Dirent type %s and Buffer name", (type, predicate) => {
    const values = codec();
    const wire: EncodedNodeValue = { kind: "fsDirent", type,
      properties: { name: { kind: "buffer", data: "5paH5Lu2" }, parentPath: value("/fixture") } };
    const dirent = values.decode(wire);
    expect(dirent[predicate]()).toBe(true);
    expect(dirent.name.toString()).toBe("文件");
    expect(values.encode(dirent)).toEqual(wire);
  });
});
