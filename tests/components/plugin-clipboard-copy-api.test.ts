// @vitest-environment node
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createPluginClipboardCopyApi } from "../../src/lib/pluginClipboardCopyApi";

type EventTargetFixture = {
  addEventListener(name: string, listener: (event?: unknown) => void): void;
  removeEventListener(name: string, listener: (event?: unknown) => void): void;
};

type ClipboardHostFixture = {
  writeText?: (text: string) => unknown;
  writeContent?: (payload: Record<string, unknown>) => unknown;
};

function fixture(options: { allowed?: boolean; host?: ClipboardHostFixture | undefined } = {}) {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const target: EventTargetFixture = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
  };
  let allowed = options.allowed ?? true;
  let host: ClipboardHostFixture | undefined = options.host ?? {};
  const permission = vi.fn(() => allowed);
  const getHost = vi.fn(() => host);
  const writeImage = vi.fn((_image: string | Uint8Array) => undefined);
  const api = createPluginClipboardCopyApi(target, { permission, host: getHost, writeImage });
  const dispatch = (name: string) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener();
  };
  return {
    api, target, listeners, dispatch, permission, getHost, writeImage,
    setAllowed(value: boolean) { allowed = value; },
    setHost(value: ClipboardHostFixture | undefined) { host = value; },
  };
}

function invokeWithArgs(method: (...args: unknown[]) => boolean, ...args: unknown[]) {
  return method(...args);
}

function pngBytes(width = 1, height = 1) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  bytes[16] = width >>> 24; bytes[17] = width >>> 16; bytes[18] = width >>> 8; bytes[19] = width;
  bytes[20] = height >>> 24; bytes[21] = height >>> 16; bytes[22] = height >>> 8; bytes[23] = height;
  return bytes;
}

const pngDataUrl = (bytes = pngBytes()) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

describe("synchronous public plugin clipboard copy API", () => {
  it("writes bounded text and reports only synchronous nullish completion", () => {
    const writeText = vi.fn(() => undefined);
    const f = fixture({ host: { writeText } });
    expect(f.api.copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    writeText.mockReturnValueOnce(null as never);
    expect(f.api.copyText("next")).toBe(true);
    writeText.mockReturnValueOnce({ ok: true } as never);
    expect(f.api.copyText("ambiguous")).toBe(false);
    expect(invokeWithArgs(f.api.copyText as (...args: unknown[]) => boolean, "extra", "argument")).toBe(false);
    expect(f.api.copyText(12 as never)).toBe(false);
    expect(f.api.copyText("é".repeat(128 * 1024 + 1))).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(3);
  });

  it("preflights supported image data URL syntax and absolute paths before forwarding", () => {
    const f = fixture({ host: {} });
    const dataUrl = pngDataUrl();
    expect(f.api.copyImage(dataUrl)).toBe(true);
    for (const mime of ["jpeg", "webp", "tiff"] as const) {
      expect(f.api.copyImage(`data:image/${mime};base64,AAAA`)).toBe(true);
    }
    expect(f.api.copyImage("/tmp/image.png")).toBe(true);
    expect(f.api.copyImage("C:\\images\\image.png")).toBe(true);
    expect(f.api.copyImage("\\\\server\\share\\image.png")).toBe(true);
    expect(f.writeImage.mock.calls.map(([value]) => value)).toEqual([
      dataUrl, "data:image/jpeg;base64,AAAA", "data:image/webp;base64,AAAA", "data:image/tiff;base64,AAAA",
      "/tmp/image.png", "C:\\images\\image.png", "\\\\server\\share\\image.png",
    ]);
    expect(f.api.copyImage("relative.png")).toBe(false);
    expect(f.api.copyImage("/tmp/" + "x".repeat(8192))).toBe(false);
    expect(f.api.copyImage("/tmp/\0bad.png")).toBe(false);
    expect(f.api.copyImage("data:image/png;base64,not-base64")).toBe(false);
  });

  it("snapshots only the visible bytes of same-realm and cross-realm Uint8Array inputs", () => {
    const f = fixture({ host: {} });
    const source = new Uint8Array([99, ...pngBytes(), 88]);
    const view = source.subarray(1, source.length - 1);
    expect(f.api.copyImage(view)).toBe(true);
    source.fill(0);
    const first = f.writeImage.mock.calls[0][0];
    expect(first).toBeInstanceOf(Uint8Array);
    expect(Array.from(first as Uint8Array)).toEqual(Array.from(pngBytes()));
    expect(first).not.toBe(view);

    const foreign = runInNewContext("new Uint8Array([7, 8, 9])") as Uint8Array;
    expect(f.api.copyImage(foreign)).toBe(true);
    const second = f.writeImage.mock.calls[1][0] as Uint8Array;
    foreign[0] = 0;
    expect(Array.from(second)).toEqual([7, 8, 9]);
    expect(second).not.toBe(foreign);
    expect(f.api.copyImage(new DataView(new ArrayBuffer(8)) as never)).toBe(false);
    expect(f.api.copyImage(new Uint16Array([1, 2]) as never)).toBe(false);
    expect(f.api.copyImage({ 0: 1, length: 1 } as never)).toBe(false);

    const buffer = Buffer.concat([Buffer.from([5]), Buffer.from(pngBytes()), Buffer.from([6])]).subarray(1, -1);
    expect(f.api.copyImage(buffer)).toBe(true);
    expect(Array.from(f.writeImage.mock.calls[2][0] as Uint8Array)).toEqual(Array.from(pngBytes()));
  });

  it("copies a byte view only after permission and host checks pass", () => {
    const source = new Uint8Array([1, 2, 3]);
    const target: EventTargetFixture = { addEventListener() {}, removeEventListener() {} };
    const writes: Uint8Array[] = [];
    const api = createPluginClipboardCopyApi(target, {
      permission() { source[0] = 4; return true; },
      host() { source[1] = 5; return {}; },
      writeImage(value) { writes.push(value as Uint8Array); return undefined; },
    });
    expect(api.copyImage(source)).toBe(true);
    expect(Array.from(writes[0])).toEqual([4, 5, 3]);
    expect(writes[0]).not.toBe(source);
  });

  it("applies image syntax and byte budgets without pretending to decode image contents", () => {
    const f = fixture({ host: {} });
    expect(f.api.copyImage(new Uint8Array(512 * 1024 + 1))).toBe(false);
    expect(f.api.copyImage(pngDataUrl(new Uint8Array(512 * 1024 + 1)))).toBe(false);
    expect(f.api.copyImage(`data:image/png;base64,${"A".repeat(700 * 1024)}`)).toBe(false);
    expect(f.api.copyImage("data:image/gif;base64,AAAA")).toBe(false);
    expect(f.api.copyImage("data:image/jpeg;base64,AA=A")).toBe(false);
    // Payload decoding belongs to the image port; this minimal header is syntactically in budget.
    expect(f.api.copyImage(pngDataUrl(pngBytes(0, 1)))).toBe(true);
    f.writeImage.mockImplementationOnce(() => { throw new Error("native decoder rejected image bytes"); });
    expect(f.api.copyImage(pngDataUrl())).toBe(false);
    expect(f.writeImage).toHaveBeenCalledTimes(2);
  });

  it("copies one file or a validated list with bounded absolute paths", () => {
    const writeContent = vi.fn(() => undefined);
    const f = fixture({ host: { writeContent } });
    expect(f.api.copyFile("/tmp/report.txt")).toBe(true);
    expect(f.api.copyFile(["/tmp/a", "D:\\docs\\b", "\\\\server\\share\\c"])).toBe(true);
    expect(writeContent.mock.calls.map(([value]) => value)).toEqual([
      { kind: "files", paths: ["/tmp/report.txt"] },
      { kind: "files", paths: ["/tmp/a", "D:\\docs\\b", "\\\\server\\share\\c"] },
    ]);
    expect(f.api.copyFile([])).toBe(false);
    expect(f.api.copyFile({ 0: "/tmp/a", length: 1 })).toBe(false);
    expect(f.api.copyFile(["relative"])).toBe(false);
    expect(f.api.copyFile(["/tmp/a", "x\0y"])).toBe(false);
    expect(f.api.copyFile(Array.from({ length: 21 }, (_, index) => `/tmp/${index}`))).toBe(false);
    expect(f.api.copyFile([`/${"x".repeat(8192)}`])).toBe(false);
    expect(f.api.copyFile(Array.from({ length: 9 }, () => `/${"x".repeat(8191)}`))).toBe(false);
    const getterPath = Object.defineProperty([], "0", { get() { throw new Error("must not run"); }, configurable: true });
    Object.defineProperty(getterPath, "length", { value: 1 });
    expect(f.api.copyFile(getterPath)).toBe(false);
    expect(writeContent).toHaveBeenCalledTimes(2);
  });

  it("returns false without writing when permission, host, endpoint, or synchronous completion is invalid", async () => {
    const writeText = vi.fn(() => undefined);
    const writeContent = vi.fn(() => undefined);
    const f = fixture({ allowed: false, host: { writeText, writeContent } });
    expect(f.api.copyText("denied")).toBe(false);
    expect(f.api.copyFile("/tmp/a")).toBe(false);
    expect(f.api.copyImage(pngDataUrl())).toBe(false);
    expect(writeText).not.toHaveBeenCalled(); expect(writeContent).not.toHaveBeenCalled(); expect(f.writeImage).not.toHaveBeenCalled();

    f.setAllowed(true); f.setHost(undefined);
    expect(f.api.copyText("no host")).toBe(false);
    expect(f.api.copyFile("/tmp/a")).toBe(false);
    expect(f.api.copyImage(pngDataUrl())).toBe(false);
    f.setHost({ writeText: () => { throw new Error("write failed"); }, writeContent: () => Promise.reject(Error("async failure")) });
    expect(f.api.copyText("throws")).toBe(false);
    expect(f.api.copyFile("/tmp/a")).toBe(false);
    f.setHost({ writeText: () => Promise.reject(Error("async failure")) });
    expect(f.api.copyText("promise")).toBe(false);
    f.writeImage.mockReturnValueOnce(Promise.reject(Error("async image failure")) as never);
    expect(f.api.copyImage(pngDataUrl())).toBe(false);
    expect(f.writeImage).toHaveBeenCalledTimes(1);
    await Promise.resolve(); await Promise.resolve();
  });

  it.each(["pagehide", "atools-plugin-out"] as const)("disables captured methods and removes listeners on %s", eventName => {
    const writeText = vi.fn(() => undefined);
    const f = fixture({ host: { writeText, writeContent: () => undefined } });
    const capturedText = f.api.copyText, capturedImage = f.api.copyImage, capturedFile = f.api.copyFile;
    expect(capturedText("before")).toBe(true);
    f.dispatch(eventName);
    expect(capturedText("after")).toBe(false);
    expect(capturedImage(pngDataUrl())).toBe(false);
    expect(capturedFile("/tmp/a")).toBe(false);
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(f.writeImage).not.toHaveBeenCalled();
  });

  it("disposes idempotently and refuses calls with extra or missing arguments", () => {
    const f = fixture({ host: { writeText: () => undefined } });
    expect(invokeWithArgs(f.api.copyText as (...args: unknown[]) => boolean)).toBe(false);
    expect(invokeWithArgs(f.api.copyFile as (...args: unknown[]) => boolean, "/tmp/a", "/tmp/b")).toBe(false);
    expect(invokeWithArgs(f.api.copyImage as (...args: unknown[]) => boolean)).toBe(false);
    f.api.dispose(); f.api.dispose();
    expect(f.api.copyText("after dispose")).toBe(false);
    const hostile = new Proxy([], {
      get() { throw new Error("disposed API must not inspect input"); },
      ownKeys() { throw new Error("disposed API must not enumerate input"); },
    });
    expect(f.api.copyFile(hostile)).toBe(false);
    expect(f.api.copyImage(hostile)).toBe(false);
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  it("works when compiled from the self-contained factory source", () => {
    const writeText = vi.fn(() => undefined);
    const f = fixture({ host: { writeText } });
    const serialized = runInNewContext(`(${createPluginClipboardCopyApi.toString()})(target, ports)`, {
      target: f.target,
      ports: { permission: () => true, host: () => ({ writeText }), writeImage: () => undefined },
      TextEncoder,
      atob,
    }) as ReturnType<typeof createPluginClipboardCopyApi>;
    expect(serialized.copyText("serialized")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("serialized");
    serialized.dispose();
    expect(serialized.copyText("closed")).toBe(false);
  });
});
