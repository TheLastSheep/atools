import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createBrowserBuffer } from "../../src/lib/browserBuffer";
import { pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { validatePluginClipboardImagePayload, createPluginNativeImageFromBytes } from "../../src/lib/pluginNativeImage";
import { createPluginNativeImageFactories } from "../../src/lib/pluginNativeImageFactories";
import { createPluginNativeImageTransformProvider } from "../../src/lib/pluginNativeImageTransformProvider";

const png = new Uint8Array(readFileSync("ZTools-plugins/plugins/calculation-paper/logo.png"));
const pngUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
const jpeg = new Uint8Array([255, 216, 255, 217, ...new Uint8Array(29)]);
const jpegUrl = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
const encodedJpeg = new Uint8Array([255, 216, 255, 217]);
const session = (responses?: (operation: string, params: Record<string, unknown>) => unknown) => {
  const calls: Array<{ operation: string; params: Record<string, unknown> }> = [];
  const identity = { nativeImageRequestSync(operation: string, params: Record<string, unknown>) {
    calls.push({ operation, params });
    if (responses) return responses(operation, params);
    if (operation === "openPath" || operation === "openBuffer") {
      return { handleId: `h${calls.length}`, format: operation === "openPath" ? "jpeg" : "png", width: 200, height: 200 };
    }
    let width = 200, height = 200;
    for (const step of (params.resizePlan as Array<{ width?: number; height?: number }> || [])) {
      if (step.width !== undefined && step.height !== undefined) { width = step.width; height = step.height; }
      else if (step.width !== undefined) { height = Math.round(step.width * height / width); width = step.width; }
      else if (step.height !== undefined) { width = Math.round(step.height * width / height); height = step.height; }
    }
    const output = params.format === "png" ? png : encodedJpeg;
    return { format: params.format, width, height, byteLength: output.length, dataBase64: Buffer.from(output).toString("base64") };
  } };
  return { identity, calls };
};

function localFactories(current: () => any, requests: ReturnType<typeof session>["calls"]) {
  const browserBuffer = createBrowserBuffer();
  const provider = createPluginNativeImageTransformProvider(current, () => browserBuffer as any);
  const factories = createPluginNativeImageFactories(
    validatePluginClipboardImagePayload,
    createPluginNativeImageFromBytes,
    () => Buffer as any,
    () => browserBuffer as any,
    (image, snapshot) => provider.decorateLocal(image as any, snapshot) as any,
    (bytes) => provider.openBuffer(bytes),
    (dataUrl) => provider.fromDataUrl(dataUrl),
    (image) => provider.payloadForWrite(image),
  );
  return { provider, factories, browserBuffer, requests };
}

describe("bounded NativeImage transform provider", () => {
  it("keeps the local PNG object and clipboard fast path, then lazily opens only on terminal transforms", () => {
    const owner = session();
    const active = { value: owner.identity };
    const { factories, requests } = localFactories(() => active.value, owner.calls);
    const local = factories.createFromBuffer(Buffer.from(png));
    expect(Object.isFrozen(local)).toBe(true);
    expect(Buffer.from(local.toPNG())).toEqual(Buffer.from(png));
    expect(factories.payloadForWrite(local)).toEqual({ dataUrl: pngUrl, width: 200, height: 200 });
    expect(owner.calls).toEqual([]);
    const resized = local.resize({ width: 100, quality: "good" });
    expect(resized.getSize()).toEqual({ width: 100, height: 100 });
    expect(owner.calls).toEqual([]);
    expect(Buffer.from(resized.toJPEG(73))).toEqual(Buffer.from(encodedJpeg));
    expect(owner.calls.map(call => call.operation)).toEqual(["openBuffer", "encode"]);
    expect(owner.calls[0].params).toEqual({ byteLength: png.byteLength, dataBase64: Buffer.from(png).toString("base64") });
    expect(owner.calls[1].params).toEqual({
      handleId: "h1", resizePlan: [{ width: 100, quality: "good" }], format: "jpeg", jpegQuality: 73,
    });
    expect(owner.calls.map(call => call.operation)).toEqual(["openBuffer", "encode"]);
    expect(requests).toBe(owner.calls);
  });

  it("requires the current session before IPC and refuses to replay a handle after rotation", () => {
    const owner = session();
    const active = { value: undefined as any };
    const { factories } = localFactories(() => active.value, owner.calls);
    const image = factories.createFromBuffer(Buffer.from(png)).resize({ height: 80 });
    expect(() => image.toJPEG(70)).toThrow("active Node image session");
    expect(owner.calls).toEqual([]);
    active.value = owner.identity;
    expect(() => image.toJPEG(70)).not.toThrow();
    active.value = session().identity;
    expect(() => image.toPNG()).toThrow("different Node session");
    expect(owner.calls.map(call => call.operation)).toEqual(["openBuffer", "encode"]);
  });

  it("shares one lazy source binding across resized wrappers and fails after session rotation", () => {
    const owner = session();
    const active = { value: owner.identity };
    const { factories } = localFactories(() => active.value, owner.calls);
    const original = factories.createFromBuffer(Buffer.from(png));
    const first = original.resize({ width: 120 });
    const second = original.resize({ width: 80 });
    expect(owner.calls).toEqual([]);
    first.toJPEG(60);
    second.toJPEG(60);
    expect(owner.calls.map(call => call.operation)).toEqual(["openBuffer", "encode", "encode"]);
    active.value = session().identity;
    expect(() => second.toJPEG(60)).toThrow("different Node session");
    expect(owner.calls).toHaveLength(3);
  });

  it("rejects the fifth resize plan step before making a request", () => {
    const owner = session();
    const { factories } = localFactories(() => owner.identity, owner.calls);
    let image = factories.createFromBuffer(Buffer.from(png));
    for (const width of [190, 180, 170, 160]) image = image.resize({ width });
    expect(() => image.resize({ width: 150 })).toThrow("plan limit");
    expect(owner.calls).toEqual([]);
  });

  it("matches the shared f32 rounding contract and accepts the ImgBatch undefined-axis shape", () => {
    const owner = session();
    const { factories } = localFactories(() => owner.identity, owner.calls);
    const imgBatchShape = factories.createFromBuffer(Buffer.from(png))
      .resize({ width: 2048, height: undefined, quality: "good" });
    expect(imgBatchShape.getSize()).toEqual({ width: 2048, height: 2048 });
    expect(owner.calls).toEqual([]);

    const ratioOwner = session((operation) => operation === "openPath"
      ? { handleId: "ratio", format: "jpeg", width: 2, height: 7 }
      : { format: "jpeg", width: 3, height: 10, byteLength: encodedJpeg.length, dataBase64: Buffer.from(encodedJpeg).toString("base64") });
    const browserBuffer = createBrowserBuffer();
    const provider = createPluginNativeImageTransformProvider(() => ratioOwner.identity, () => browserBuffer as any);
    // f32(2/7), then f32(1/ratio), then f32(3*factor) rounds to 10.
    // Dividing 3 by the ratio rounds to 11 and is intentionally not the contract.
    expect(provider.openPath("/tmp/ratio.jpg").resize({ width: 3 }).getSize())
      .toEqual({ width: 3, height: 10 });

    const secondOwner = session(operation => operation === "openPath"
      ? { handleId: "ratio-2", format: "jpeg", width: 4, height: 7 }
      : { format: "jpeg", width: 2, height: 4, byteLength: encodedJpeg.length, dataBase64: Buffer.from(encodedJpeg).toString("base64") });
    const secondProvider = createPluginNativeImageTransformProvider(() => secondOwner.identity, () => browserBuffer as any);
    // This confirms the f32 reciprocal result on another near-half vector.
    expect(secondProvider.openPath("/tmp/ratio-2.jpg").resize({ width: 2 }).getSize())
      .toEqual({ width: 2, height: 3 });

    const tieOwner = session(operation => operation === "openPath"
      ? { handleId: "ratio-tie", format: "jpeg", width: 2, height: 5 }
      : { format: "jpeg", width: 1, height: 3, byteLength: encodedJpeg.length, dataBase64: Buffer.from(encodedJpeg).toString("base64") });
    const tieProvider = createPluginNativeImageTransformProvider(() => tieOwner.identity, () => browserBuffer as any);
    expect(tieProvider.openPath("/tmp/ratio-tie.jpg").resize({ width: 1 }).getSize())
      .toEqual({ width: 1, height: 3 });
  });

  it("rejects oversized and non-canonical base64 before allocating through Buffer", () => {
    const from = vi.fn((value: any) => Buffer.from(value));
    const browserBuffer = createBrowserBuffer();
    const provider = createPluginNativeImageTransformProvider(
      () => ({ nativeImageRequestSync: vi.fn() }),
      () => ({ from, isBuffer: Buffer.isBuffer } as any),
    );
    expect(() => provider.fromDataUrl("data:image/jpeg;base64," + "A".repeat(700 * 1024))).toThrow();
    expect(() => provider.fromDataUrl("data:image/jpeg;base64,AB==")).toThrow();
    expect(from).not.toHaveBeenCalled();
    expect(browserBuffer.isBuffer(new Uint8Array())).toBe(false);
  });

  it("accepts a 512 KiB terminal payload and rejects maximum-plus-one before Buffer decoding", () => {
    const supported = Buffer.alloc(512 * 1024);
    supported.set([255, 216, 255, 217]);
    const overLimit = Buffer.alloc(512 * 1024 + 1);
    overLimit.set([255, 216, 255, 217]);
    const response = (bytes: Uint8Array) => ({
      format: "jpeg", width: 1, height: 1, byteLength: bytes.byteLength,
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
    const makeProvider = (bytes: Uint8Array) => {
      const buffer = createBrowserBuffer();
      const originalFrom = buffer.from.bind(buffer);
      const from = vi.fn((value: any, encoding?: string) => originalFrom(value, encoding));
      const active = { nativeImageRequestSync(operation: string) {
        return operation === "openPath" ? { handleId: "bounded", format: "jpeg", width: 1, height: 1 } : response(bytes);
      } };
      const provider = createPluginNativeImageTransformProvider(() => active, () => ({ ...buffer, from } as any));
      return { provider, from };
    };
    const exact = makeProvider(supported);
    expect(exact.provider.openPath("/tmp/encoded.jpg").toJPEG(80)).toHaveLength(512 * 1024);
    expect(exact.from).toHaveBeenCalledOnce();
    const tooLarge = makeProvider(overLimit);
    const image = tooLarge.provider.openPath("/tmp/encoded.jpg");
    expect(() => image.toJPEG(80)).toThrow("Invalid NativeImage encoded response");
    expect(tooLarge.from).not.toHaveBeenCalled();
  });

  it("revalidates a transform-branded clipboard payload before the host write boundary", () => {
    const browserBuffer = createBrowserBuffer();
    const payload = { dataUrl: pngUrl, width: 200, height: 200, extra: "forged" };
    const decoratedPayload = vi.fn(() => payload as any);
    const validator = vi.fn(validatePluginClipboardImagePayload);
    const factories = createPluginNativeImageFactories(
      validator,
      createPluginNativeImageFromBytes,
      () => Buffer as any,
      () => browserBuffer as any,
      undefined, undefined, undefined, decoratedPayload,
    );
    expect(() => factories.payloadForWrite({})).toThrow();
    expect(decoratedPayload).toHaveBeenCalledOnce();
    expect(validator).toHaveBeenCalledOnce();
  });

  it("routes supported non-PNG buffer and data URL inputs through the typed transform channel", () => {
    const owner = session((operation, params) => operation === "openBuffer"
      ? { handleId: `h${owner.calls.length}`, format: "jpeg", width: 2, height: 1 }
      : { format: "png", width: 2, height: 1, byteLength: png.byteLength, dataBase64: Buffer.from(png).toString("base64") });
    const { factories } = localFactories(() => owner.identity, owner.calls);
    const fromBytes = factories.createFromBuffer(Buffer.from(jpeg));
    expect(fromBytes.getSize()).toEqual({ width: 2, height: 1 });
    const fromUrl = factories.createFromDataURL(jpegUrl);
    expect(fromUrl.getSize()).toEqual({ width: 2, height: 1 });
    expect(owner.calls.map(call => call.operation)).toEqual(["openBuffer", "openBuffer"]);
    expect(owner.calls[0].params).toEqual({ byteLength: jpeg.byteLength, dataBase64: Buffer.from(jpeg).toString("base64") });
    expect(() => factories.createFromDataURL("data:image/gif;base64,AAAA")).toThrow();
    expect(() => factories.createFromBuffer(Buffer.alloc(513 * 1024))).toThrow("supported limit");
  });

  it("uses exact transform request shapes and rejects extra descriptor fields", () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const active = {
      nativeImageRequestSync(operation: string, params: Record<string, unknown>) {
        calls.push({ method: operation, params });
        if (operation === "openPath") return { handleId: "path-handle", format: "jpeg", width: 200, height: 200 };
        const step = (params.resizePlan as Array<{ width?: number; height?: number }>)[0];
        return { format: "jpeg", width: step?.width ?? 200, height: step?.width ? 100 : step?.height ?? 200,
          byteLength: encodedJpeg.length, dataBase64: Buffer.from(encodedJpeg).toString("base64") };
      },
    };
    const browserBuffer = createBrowserBuffer();
    const provider = createPluginNativeImageTransformProvider(() => active, () => browserBuffer as any);
    const image = provider.openPath("/private/source.jpg").resize({ width: 100 });
    expect(image.getSize()).toEqual({ width: 100, height: 100 });
    expect(image.toJPEG(50)).toEqual(expect.any(Uint8Array));
    expect(calls).toEqual([
      { method: "openPath", params: { path: "/private/source.jpg" } },
      { method: "encode", params: { handleId: "path-handle", resizePlan: [{ width: 100, quality: "best" }], format: "jpeg", jpegQuality: 50 } },
    ]);
    const bad = createPluginNativeImageTransformProvider(() => ({ nativeImageRequestSync: () => ({ handleId: "h", format: "png", width: 1, height: 1, extra: true }) }), () => browserBuffer as any);
    expect(() => bad.openPath("/private/x.png")).toThrow("Invalid NativeImage response");
  });

  it("late-injects the Node session and routes createFromPath outside the legacy byte reader", () => {
    const calls: Array<{ operation: string; params: Record<string, unknown> }> = [];
    let nextHandle = 0;
    const writeImage = vi.fn();
    const activeWindow: any = {
      require: (specifier: string) => specifier === "electron" ? { ipcRenderer: {} } : {},
      utools: { getAppName: () => "ATools", getAppVersion: () => "test" },
      Buffer,
      __atoolsHostClipboard: { writeImage },
    };
    const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    new Function("window", script)(activeWindow);
    const electron = activeWindow.require("electron");
    const legacyRead = vi.fn(() => { throw new Error("legacy byte reader must not receive an image object"); });
    activeWindow.__atoolsNodeModuleRequire = {
      readPngPath: legacyRead,
      nativeImageRequestSync(operation: string, params: Record<string, unknown>) {
        calls.push({ operation, params });
        if (operation === "openPath") return { handleId: `path-${++nextHandle}`, format: "jpeg", width: 200, height: 200 };
        const steps = params.resizePlan as Array<{ width?: number; height?: number }>;
        let width = 200, height = 200;
        for (const step of steps) {
          if (step.width !== undefined && step.height !== undefined) { width = step.width; height = step.height; }
          else if (step.width !== undefined) { height = Math.round(step.width * height / width); width = step.width; }
          else if (step.height !== undefined) { width = Math.round(step.height * width / height); height = step.height; }
        }
        const bytes = params.format === "png" ? png : encodedJpeg;
        return { format: params.format, width, height, byteLength: bytes.length, dataBase64: Buffer.from(bytes).toString("base64") };
      },
    };
    const resized = electron.nativeImage.createFromPath("/tmp/source.jpg").resize({ width: 100 });
    expect(resized.getSize()).toEqual({ width: 100, height: 100 });
    expect(Buffer.from(resized.toJPEG(72))).toEqual(Buffer.from(encodedJpeg));
    expect(calls.map(call => call.operation)).toEqual(["openPath", "encode"]);
    expect(calls[0].params).toEqual({ path: "/tmp/source.jpg" });
    const writable = electron.nativeImage.createFromPath("/tmp/write.png");
    expect(electron.clipboard.writeImage(writable)).toBeUndefined();
    expect(writeImage).toHaveBeenCalledWith({ dataUrl: pngUrl, width: 200, height: 200 });
    expect(calls.map(call => call.operation)).toEqual(["openPath", "encode", "openPath", "encode"]);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(Object.isFrozen(calls[1].params)).toBe(true);
    expect(Object.isFrozen(calls[1].params.resizePlan)).toBe(true);
    expect(Object.isFrozen(calls[1].params.resizePlan[0])).toBe(true);
  });
});
