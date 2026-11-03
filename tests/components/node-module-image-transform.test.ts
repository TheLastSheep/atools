import { describe, expect, it, vi } from "vitest";
import { makeNodeModuleRequire } from "../../src/lib/nodeModuleBridge";

describe("NodeModuleRequire nativeImageRequestSync", () => {
  it("uses the dedicated transport method without the Node value codec", () => {
    const requestSync = vi.fn(() => ({ handleId: "h1", format: "png", width: 4, height: 3 }));
    const require = makeNodeModuleRequire({ endpoint: "http://127.0.0.1:1234/session" }, {
      requestSync,
      requestAsync: vi.fn(async () => null),
    });
    const result = require.nativeImageRequestSync("openBuffer", { byteLength: 33, dataBase64: "AA==" });
    expect(result).toEqual({ handleId: "h1", format: "png", width: 4, height: 3 });
    expect(requestSync).toHaveBeenCalledOnce();
    expect(requestSync).toHaveBeenCalledWith("nativeImageTransform", {
      byteLength: 33, dataBase64: "AA==", operation: "openBuffer",
    });
    expect(() => require.nativeImageRequestSync("other" as any, {})).toThrow("Unsupported NativeImage operation");
    require.close();
    expect(() => require.nativeImageRequestSync("encode", { handleId: "h1" })).toThrow("session is closed");
    expect(requestSync).toHaveBeenCalledOnce();
  });
});
