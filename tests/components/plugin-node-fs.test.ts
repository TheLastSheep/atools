import { describe, expect, it, vi } from "vitest";
import { createPluginNodeFs } from "../../src/lib/pluginNodeFs";

describe("Plugin Node fs facade", () => {
  it("reads small absolute POSIX UTF-8 paths through nativeRead and preserves the BOM", () => {
    const nativeRead = vi.fn(() => ({ handled: true as const, value: "\uFEFFhello" }));
    const hostFs = vi.fn(() => ({ readFileSync: vi.fn(() => "host") }));
    const fs = createPluginNodeFs(nativeRead, hostFs);

    expect(fs.module.readFileSync("/plugin/data.txt", "utf8")).toBe("\uFEFFhello");
    expect(nativeRead).toHaveBeenCalledWith("/plugin/data.txt");
    expect(hostFs).not.toHaveBeenCalled();
    fs.close();
  });

  it("falls back once with the original arguments only when nativeRead declines", () => {
    const nativeRead = vi.fn(() => ({ handled: false as const }));
    const readFileSync = vi.fn(function (this: object, ...args: unknown[]) {
      expect(this).toBe(hostModule);
      return args;
    });
    const hostModule = { readFileSync };
    const hostFs = vi.fn(() => hostModule);
    const fs = createPluginNodeFs(nativeRead, hostFs);

    expect(fs.module.readFileSync("/plugin/data.txt", "utf-8")).toEqual(["/plugin/data.txt", "utf-8"]);
    expect(nativeRead).toHaveBeenCalledTimes(1);
    expect(hostFs).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    fs.close();
  });

  it("does not fall back when nativeRead throws or returns an invalid response", () => {
    const permissionError = Object.assign(new Error("permission denied"), { code: "PERMISSION_DENIED" });
    const hostFs = vi.fn(() => ({ readFileSync: vi.fn(() => "host") }));
    const throwing = createPluginNodeFs(() => { throw permissionError; }, hostFs);

    let observed: unknown;
    try { throwing.module.readFileSync("/plugin/private.txt", "utf8"); } catch (error) { observed = error; }
    expect(observed).toBe(permissionError);
    expect(hostFs).not.toHaveBeenCalled();
    throwing.close();

    const hostError = Object.assign(new Error("host read failed"), { code: "EIO" });
    const declined = createPluginNodeFs(
      () => ({ handled: false }),
      () => ({ readFileSync: () => { throw hostError; } }),
    );
    let fallbackError: unknown;
    try { declined.module.readFileSync("/plugin/data.txt", "utf8"); } catch (error) { fallbackError = error; }
    expect(fallbackError).toBe(hostError);
    declined.close();

    for (const invalid of [
      { handled: true, value: 1 },
      { handled: false, value: "ignored" },
      { handled: true, value: "ok", extra: true },
    ]) {
      const facade = createPluginNodeFs(() => invalid, hostFs);
      expect(() => facade.module.readFileSync("/plugin/data.txt", "utf8"))
        .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NATIVE_FS_RESPONSE" }));
      facade.close();
    }
    expect(hostFs).not.toHaveBeenCalled();
  });

  it("delegates unsupported paths, signatures, and encodings without probing nativeRead", () => {
    const nativeRead = vi.fn(() => ({ handled: true as const, value: "native" }));
    const readFileSync = vi.fn((...args: unknown[]) => args);
    const hostFs = vi.fn(() => ({ readFileSync }));
    const fs = createPluginNodeFs(nativeRead, hostFs);
    const bufferLike = { type: "Buffer", data: [1, 2] };
    const unsupportedCalls: unknown[][] = [
      ["relative.txt", "utf8"],
      ["/plugin/with\0nul", "utf8"],
      ["C:\\plugin\\data.txt", "utf8"],
      ["/plugin/data.txt"],
      ["/plugin/data.txt", "utf8", "extra"],
      ["/plugin/data.txt", "UTF8"],
      ["/plugin/data.txt", { encoding: "utf8" }],
      [new URL("file:///plugin/data.txt"), "utf8"],
      [23, "utf8"],
      [bufferLike, "utf8"],
    ];

    for (const args of unsupportedCalls) expect(fs.module.readFileSync(...args)).toEqual(args);
    expect(nativeRead).not.toHaveBeenCalled();
    expect(readFileSync.mock.calls).toEqual(unsupportedCalls);
    fs.close();
  });

  it("enforces the UTF-8 byte budget, including multibyte paths", () => {
    const nativeRead = vi.fn(() => ({ handled: true as const, value: "native" }));
    const readFileSync = vi.fn(() => "host");
    const fs = createPluginNodeFs(nativeRead, () => ({ readFileSync }));

    expect(fs.module.readFileSync(`/${"a".repeat(8191)}`, "utf8")).toBe("native");
    expect(fs.module.readFileSync(`/${"a".repeat(8192)}`, "utf8")).toBe("host");
    expect(fs.module.readFileSync(`/${"雪".repeat(2731)}`, "utf8")).toBe("host");
    expect(nativeRead).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledTimes(2);
    fs.close();
  });

  it("invalidates the facade and captured read function on close without closing borrowed host fs", () => {
    const nativeRead = vi.fn(() => ({ handled: true as const, value: "native" }));
    const hostModule = { readFileSync: vi.fn(() => "host"), close: vi.fn() };
    const fs = createPluginNodeFs(nativeRead, () => hostModule);
    const capturedRead = fs.module.readFileSync;

    expect(capturedRead("/plugin/data.txt", "utf8")).toBe("native");
    fs.close();
    expect(() => fs.module.readFileSync("/plugin/data.txt", "utf8"))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_FS_CLOSED" }));
    expect(() => capturedRead("/plugin/data.txt", "utf8"))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_FS_CLOSED" }));
    expect(hostModule.close).not.toHaveBeenCalled();
  });

  it("delegates non-read reflection lazily to the host module", () => {
    const hostConstants = { O_RDONLY: 0 };
    const hostModule = Object.defineProperties({ readFileSync: () => "host" }, {
      constants: { configurable: false, enumerable: true, writable: false, value: hostConstants },
    });
    const hostFs = vi.fn(() => hostModule);
    const fs = createPluginNodeFs(() => ({ handled: true as const, value: "native" }), hostFs);

    expect(hostFs).not.toHaveBeenCalled();
    expect(fs.module.readFileSync("/plugin/data.txt", "utf8")).toBe("native");
    expect(hostFs).not.toHaveBeenCalled();
    expect("constants" in fs.module).toBe(true);
    expect(Object.keys(fs.module)).toEqual(expect.arrayContaining(["readFileSync", "constants"]));
    expect(Object.getOwnPropertyDescriptor(fs.module, "constants")).toMatchObject({
      configurable: true,
      enumerable: true,
      writable: false,
      value: hostConstants,
    });
    expect(Object.getOwnPropertyDescriptor(fs.module, "readFileSync").value)
      .toBe(fs.module.readFileSync);
    expect(hostFs).toHaveBeenCalledTimes(1);
    fs.close();
  });

  it("writes small UTF-8 strings through nativeWrite and returns undefined", () => {
    const nativeWrite = vi.fn(() => ({ handled: true as const }));
    const hostWrite = vi.fn(() => "host");
    const hostFs = vi.fn(() => ({ readFileSync: vi.fn(), writeFileSync: hostWrite }));
    const fs = createPluginNodeFs(undefined, hostFs, nativeWrite);

    expect(fs.module.writeFileSync("/plugin/目录📁.txt", "世界 🧪\n")).toBeUndefined();
    expect(fs.module.writeFileSync("/plugin/notes.txt", "hello", "utf8")).toBeUndefined();
    expect(fs.module.writeFileSync("/plugin/notes.txt", "hello", "utf-8")).toBeUndefined();
    expect(nativeWrite.mock.calls).toEqual([
      ["/plugin/目录📁.txt", "世界 🧪\n"],
      ["/plugin/notes.txt", "hello"],
      ["/plugin/notes.txt", "hello"],
    ]);
    expect(hostFs).not.toHaveBeenCalled();
    fs.close();
  });

  it("falls back once with original write arguments only when nativeWrite declines", () => {
    const nativeWrite = vi.fn(() => ({ handled: false as const }));
    const writeFileSync = vi.fn(function (this: object, ...args: unknown[]) {
      expect(this).toBe(hostModule);
      return args;
    });
    const hostModule = { readFileSync: vi.fn(), writeFileSync };
    const hostFs = vi.fn(() => hostModule);
    const fs = createPluginNodeFs(undefined, hostFs, nativeWrite);

    expect(fs.module.writeFileSync("/plugin/data.txt", "hello", "utf-8"))
      .toEqual(["/plugin/data.txt", "hello", "utf-8"]);
    expect(nativeWrite).toHaveBeenCalledTimes(1);
    expect(hostFs).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    fs.close();
  });

  it("does not retry native write errors or accept malformed handled responses", () => {
    const nativeError = Object.assign(new Error("native permission denied"), { code: "EACCES" });
    const hostFs = vi.fn(() => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));
    const throwing = createPluginNodeFs(undefined, hostFs, () => { throw nativeError; });
    let observed: unknown;
    try { throwing.module.writeFileSync("/plugin/data.txt", "hello"); } catch (error) { observed = error; }
    expect(observed).toBe(nativeError);
    expect(hostFs).not.toHaveBeenCalled();
    throwing.close();

    const invalidResponses = [
      { handled: true, value: undefined },
      { handled: false, value: "unexpected" },
      { handled: true, extra: true },
      { handled: "true" },
      { handled: true, [Symbol("extra")]: true },
      Object.defineProperty({}, "handled", { enumerable: true, get: () => true }),
    ];
    for (const invalid of invalidResponses) {
      const facade = createPluginNodeFs(undefined, hostFs, () => invalid);
      expect(() => facade.module.writeFileSync("/plugin/data.txt", "hello"))
        .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_NATIVE_FS_RESPONSE" }));
      facade.close();
    }
    expect(hostFs).not.toHaveBeenCalled();
  });

  it("delegates unsupported write signatures and enforces UTF-8 byte and surrogate budgets", () => {
    const nativeWrite = vi.fn(() => ({ handled: true as const }));
    const writeFileSync = vi.fn((...args: unknown[]) => args);
    const fs = createPluginNodeFs(undefined, () => ({ readFileSync: vi.fn(), writeFileSync }), nativeWrite);
    const bufferLike = { type: "Buffer", data: [1, 2] };
    const unsupportedCalls: unknown[][] = [
      ["relative.txt", "text"],
      ["/plugin/with\0nul", "text"],
      [`/${"a".repeat(8192)}`, "text"],
      [`/${"雪".repeat(2731)}`, "text"],
      ["/plugin/data.txt", "\uD800"],
      ["/plugin/\uD800.txt", "text"],
      ["/plugin/data.txt", "text", undefined],
      ["/plugin/data.txt", "text", { encoding: "utf8" }],
      ["/plugin/data.txt", "text", "UTF8"],
      ["/plugin/data.txt", "text", "utf8", "extra"],
      ["/plugin/data.txt", bufferLike],
      [new URL("file:///plugin/data.txt"), "text"],
      [23, "text"],
      ["/plugin/data.txt", "x".repeat(512 * 1024 + 1)],
    ];
    for (const args of unsupportedCalls) expect(fs.module.writeFileSync(...args)).toEqual(args);
    expect(nativeWrite).not.toHaveBeenCalled();
    expect(writeFileSync.mock.calls).toEqual(unsupportedCalls);

    const exactUtf8Data = `${"雪".repeat(174_762)}ab`;
    expect(exactUtf8Data.length).toBeLessThan(512 * 1024);
    expect(new TextEncoder().encode(exactUtf8Data).byteLength).toBe(512 * 1024);
    const exactUtf8Path = `/${"雪".repeat(2730)}a`;
    expect(new TextEncoder().encode(exactUtf8Path).byteLength).toBe(8192);
    expect(fs.module.writeFileSync(exactUtf8Path, exactUtf8Data)).toBeUndefined();
    expect(nativeWrite).toHaveBeenCalledWith(exactUtf8Path, exactUtf8Data);
    fs.close();
  });

  it("invalidates captured native write functions on close without closing host fs", () => {
    const nativeWrite = vi.fn(() => ({ handled: true as const }));
    const hostModule = { readFileSync: vi.fn(), writeFileSync: vi.fn(), close: vi.fn() };
    const fs = createPluginNodeFs(undefined, () => hostModule, nativeWrite);
    const capturedWrite = fs.module.writeFileSync;

    expect(capturedWrite("/plugin/data.txt", "text")).toBeUndefined();
    fs.close();
    expect(() => capturedWrite("/plugin/data.txt", "text"))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_FS_CLOSED" }));
    expect(hostModule.close).not.toHaveBeenCalled();
  });
});
