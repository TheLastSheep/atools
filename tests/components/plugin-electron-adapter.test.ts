import { describe, expect, it, vi } from "vitest";
import { createPluginElectronAdapter, pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { createPluginNativeImage } from "../../src/lib/pluginNativeImage";
import packageInfo from "../../package.json";

const application = { name: packageInfo.productName, version: packageInfo.version };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function installSerializedAdapter(utools: Record<string, unknown> = {}) {
  const other = {}, broker = { on: vi.fn() }, error = vi.fn();
  const hostWindow: any = {
    require: vi.fn((specifier) => specifier === "electron" ? { ipcRenderer: broker } : other),
    console: { error },
    utools: { getAppName: () => application.name, getAppVersion: () => application.version, ...utools },
  };
  if (utools.__atoolsHostClipboard) hostWindow.__atoolsHostClipboard = utools.__atoolsHostClipboard;
  const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  new Function("window", script)(hostWindow);
  return { hostWindow, electron: hostWindow.require("electron"), error, other };
}

describe("Local Electron host adapter", () => {
  it("returns actual application metadata synchronously without inventing an Electron version", () => {
    const electron = createPluginElectronAdapter({ application });
    expect(electron.app.getName()).toBe(packageInfo.productName);
    expect(electron.app.getVersion()).toBe(packageInfo.version);
    expect(typeof electron.app.getVersion()).toBe("string");
    expect(() => electron.app.getPath()).toThrow("synchronous host transport");
    expect("versions" in electron).toBe(false);
  });

  it("delegates async shell operations and follows Electron completion contracts", async () => {
    const invokeNative = vi.fn(async () => null);
    const electron = createPluginElectronAdapter({ application, invokeNative });
    await expect(electron.shell.openExternal("https://example.invalid")).resolves.toBeUndefined();
    await expect(electron.shell.openPath("/temporary/fixture.txt")).resolves.toBe("");
    expect(invokeNative.mock.calls).toEqual([
      ["shellOpenExternal", { url: "https://example.invalid" }],
      ["shellOpenPath", { path: "/temporary/fixture.txt" }],
    ]);
    invokeNative.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(electron.shell.openExternal("https://example.invalid")).rejects.toThrow("Permission denied");
    invokeNative.mockRejectedValueOnce(new Error("File not found"));
    await expect(electron.shell.openPath("/missing")).resolves.toBe("File not found");
    await expect(electron.shell.openExternal("https://example.invalid", { activate: false })).rejects.toThrow("options");
    expect(invokeNative).toHaveBeenCalledTimes(4);
  });

  it("reveals once, returns void before native completion and reports the original async failure", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise((_, fail) => { reject = fail; });
    const invokeNative = vi.fn(() => pending), reportError = vi.fn();
    const electron = createPluginElectronAdapter({ application, invokeNative, reportError });
    const path = "/tmp/原始文件 ";
    expect(electron.shell.showItemInFolder(path)).toBeUndefined();
    expect(invokeNative).not.toHaveBeenCalled();
    await settle();
    expect(invokeNative.mock.calls).toEqual([["shellShowItemInFolder", { path }]]);
    expect(reportError).not.toHaveBeenCalled();
    const denied = { code: "PERMISSION_DENIED", message: "Permission was not granted" };
    reject(denied);
    await settle();
    expect(reportError.mock.calls).toEqual([[denied, "shell.showItemInFolder"]]);
    await settle();
    expect(invokeNative).toHaveBeenCalledTimes(1);
  });

  it("resolves trash only after native completion and preserves paths and rejected values", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const invokeNative = vi.fn(() => pending);
    const electron = createPluginElectronAdapter({ application, invokeNative });
    const path = "/tmp/保留尾空格 ";
    const result = electron.shell.trashItem(path), completed = vi.fn();
    expect(result).toBeInstanceOf(Promise);
    void result.then(completed);
    await settle();
    expect(completed).not.toHaveBeenCalled();
    expect(invokeNative.mock.calls).toEqual([["shellTrashItem", { path }]]);
    resolve(null);
    await expect(result).resolves.toBeUndefined();
    expect(completed).toHaveBeenCalledOnce();
    for (const failure of [new Error("OS permission denied"), { code: "USER_CANCELED" }, "native failure"]) {
      invokeNative.mockRejectedValueOnce(failure);
      await expect(electron.shell.trashItem(path)).rejects.toBe(failure);
    }
    expect(invokeNative).toHaveBeenCalledTimes(4);
  });

  it.each(["C:\\temporary\\file.txt", "D:/temporary/file.txt", "\\\\server\\share\\file.txt", "/tmp/文档.txt "])(
    "passes the exact absolute path %s to each added shell method", async (path) => {
      const invokeNative = vi.fn(async () => undefined);
      const electron = createPluginElectronAdapter({ application, invokeNative });
      expect(electron.shell.showItemInFolder(path)).toBeUndefined();
      await expect(electron.shell.trashItem(path)).resolves.toBeUndefined();
      expect(invokeNative.mock.calls).toEqual([
        ["shellShowItemInFolder", { path }], ["shellTrashItem", { path }],
      ]);
    },
  );

  it.each([undefined, null, 3, {}, "", "  ", "relative.txt", "C:relative.txt", "file:///tmp/file", "/tmp/bad\0file", "/" + "a".repeat(8192)])(
    "rejects an invalid new shell path before any transport call: %j", async (path) => {
      const invokeNative = vi.fn(async () => null), reportError = vi.fn();
      const electron = createPluginElectronAdapter({ application, invokeNative, reportError });
      expect(() => electron.shell.showItemInFolder(path as string)).toThrow("Path");
      await expect(electron.shell.trashItem(path as string)).rejects.toThrow("Path");
      expect(invokeNative).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each([null, {}, [], true, { deletePermanently: true }, { activate: false }])(
    "rejects extra shell options without initiating or replaying a native operation: %j", async (options) => {
      const invokeNative = vi.fn(async () => null);
      const electron = createPluginElectronAdapter({ application, invokeNative });
      expect(() => electron.shell.showItemInFolder("/tmp/file", options)).toThrow("options");
      await expect(electron.shell.trashItem("/tmp/file", options)).rejects.toThrow("options");
      await settle();
      expect(invokeNative).not.toHaveBeenCalled();
    },
  );

  it("rejects unavailable transports before starting the added methods", async () => {
    for (const invokeNative of [undefined, null, {}]) {
      const reportError = vi.fn();
      const electron = createPluginElectronAdapter({ application, invokeNative: invokeNative as never, reportError });
      expect(() => electron.shell.showItemInFolder("/tmp/file")).toThrow("authorized host transport");
      await expect(electron.shell.trashItem("/tmp/file")).rejects.toThrow("UNSUPPORTED");
      expect(reportError).not.toHaveBeenCalled();
    }
  });

  it("reports reveal errors through console when no reporter exists, with no failure replay", async () => {
    const denied = new Error("Permission denied"), canceled = { code: "CANCELED" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeNative = vi.fn().mockRejectedValueOnce(denied).mockImplementationOnce(() => { throw canceled; });
    const electron = createPluginElectronAdapter({ application, invokeNative });
    electron.shell.showItemInFolder("/tmp/file");
    await settle();
    electron.shell.showItemInFolder("/tmp/file");
    await settle();
    expect(consoleError.mock.calls).toEqual([
      ["[ATools electron shell.showItemInFolder]", denied],
      ["[ATools electron shell.showItemInFolder]", canceled],
    ]);
    expect(invokeNative).toHaveBeenCalledTimes(2);
  });

  it.each(["throw", "reject"])("falls back with the original reveal failure if its reporter %ss", async (kind) => {
    const denied = new Error("OS failure"), reporterError = new Error("Observer failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const reportError = vi.fn(() => { if (kind === "throw") throw reporterError; return Promise.reject(reporterError); });
    const invokeNative = vi.fn(async () => { throw denied; });
    const electron = createPluginElectronAdapter({ application, invokeNative, reportError });
    expect(electron.shell.showItemInFolder("/tmp/file")).toBeUndefined();
    await settle();
    expect(reportError).toHaveBeenCalledWith(denied, "shell.showItemInFolder");
    expect(consoleError).toHaveBeenCalledWith("[ATools electron shell.showItemInFolder]", denied, reporterError);
    expect(invokeNative).toHaveBeenCalledOnce();
  });

  it("rejects fabricated shell completion payloads and observes reveal protocol errors", async () => {
    const reportError = vi.fn(), invokeNative = vi.fn(async () => false);
    const electron = createPluginElectronAdapter({ application, invokeNative, reportError });
    electron.shell.showItemInFolder("/tmp/file");
    await expect(electron.shell.trashItem("/tmp/file")).rejects.toThrow("Invalid native shell response");
    await settle();
    expect(reportError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(reportError.mock.calls[0][0].message).toBe("Invalid native shell response");
    expect(invokeNative).toHaveBeenCalledTimes(2);
  });

  it("preserves hosted IPC listeners and chaining while rejecting unimplemented main-process calls", async () => {
    const on = vi.fn(), once = vi.fn();
    const electron = createPluginElectronAdapter({ application, ipcRenderer: { on, once } });
    const callback = () => {};
    expect(electron.ipcRenderer.on("ping", callback).once("pong", callback)).toBe(electron.ipcRenderer);
    expect(on).toHaveBeenCalledWith("ping", callback);
    expect(once).toHaveBeenCalledWith("pong", callback);
    expect(() => electron.ipcRenderer.send("custom", "private")).toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
    await expect(electron.ipcRenderer.invoke("custom")).rejects.toThrow("ERR_ATOOLS_ELECTRON_UNSUPPORTED");
  });

  it("allows only the bounded open-external IPC alias and never retries a failed native call", async () => {
    const invokeNative = vi.fn(async () => null);
    const electron = createPluginElectronAdapter({ application, invokeNative });
    await expect(electron.ipcRenderer.invoke("open-external", "https://example.invalid/a?b=1")).resolves.toBeUndefined();
    expect(invokeNative.mock.calls).toEqual([["shellOpenExternal", { url: "https://example.invalid/a?b=1" }]]);

    const denied = new Error("Permission denied");
    invokeNative.mockRejectedValueOnce(denied);
    await expect(electron.ipcRenderer.invoke("open-external", "https://example.invalid/denied")).rejects.toBe(denied);
    const synchronousFailure = new Error("Native bridge unavailable");
    invokeNative.mockImplementationOnce(() => { throw synchronousFailure; });
    await expect(electron.ipcRenderer.invoke("open-external", "https://example.invalid/throw")).rejects.toBe(synchronousFailure);
    expect(invokeNative).toHaveBeenCalledTimes(3);

    for (const args of [
      ["unknown", "https://example.invalid"],
      ["open-external"],
      ["open-external", "https://example.invalid", "extra"],
      ["open-external", ""],
      ["open-external", "   "],
      ["open-external", undefined],
      ["open-external", null],
      ["open-external", 42],
      ["open-external", "x".repeat(8193)],
      ["open-external", "é".repeat(4097)],
    ]) {
      await expect(electron.ipcRenderer.invoke(...args)).rejects.toThrow();
    }
    expect(invokeNative).toHaveBeenCalledTimes(3);
  });

  it("does not return fabricated empty clipboard data, null images or successful writes", async () => {
    const electron = createPluginElectronAdapter({ application });
    for (const method of ["readText", "readImage", "writeText", "writeImage", "availableFormats"]) {
      expect(() => electron.clipboard[method]("fixture")).toThrow("synchronous authorized host transport");
    }
    expect(() => electron.nativeImage.createFromPath("/fixture.png")).toThrow("nativeImage.createFromPath");
    await expect(electron.shell.openExternal("https://example.invalid")).rejects.toThrow("UNSUPPORTED");
  });

  it("returns a synchronous bounded NativeImage from the explicit host image transport", () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7w8AAAAASUVORK5CYII=", "base64");
    const data = { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, width: 1, height: 1 };
    const readImage = vi.fn(() => data);
    const electron = createPluginElectronAdapter({ application, clipboard: { readText: () => "", writeText: () => {}, readImage }, createNativeImage: createPluginNativeImage });
    const image = electron.clipboard.readImage() as ReturnType<typeof createPluginNativeImage>;
    expect(image.isEmpty()).toBe(false);
    expect(image.getSize()).toEqual({ width: 1, height: 1 });
    expect(image.toDataURL()).toBe(data.dataUrl);
    expect(Buffer.isBuffer(image.toPNG())).toBe(true);
    expect(image.toPNG()).toEqual(bytes);
    expect(() => electron.clipboard.readImage("selection")).toThrow("Selection clipboard");
    expect(readImage).toHaveBeenCalledTimes(1);
  });

  it("serializes the production adapter with its NativeImage helper and preserves an empty image", () => {
    const empty = installSerializedAdapter({ __atoolsHostClipboard: { readImage: () => null } });
    const image = empty.electron.clipboard.readImage();
    expect(image.isEmpty()).toBe(true);
    expect(image.getSize()).toEqual({ width: 0, height: 0 });
    expect(image.toPNG()).toHaveLength(0);
    expect(image.toDataURL()).toBe("data:image/png;base64,");
  });

  it("serializes without dependencies and retains local Electron before the Node require wrapper captures it", async () => {
    const other = {}, broker = { on: vi.fn() };
    const localRequire = vi.fn((specifier) => specifier === "electron" ? { ipcRenderer: broker } : other);
    const hostWindow: any = {
      require: localRequire,
      utools: {
        getAppName: () => application.name, getAppVersion: () => application.version,
        shellOpenExternal: vi.fn(async () => null), shellOpenPath: vi.fn(async () => null),
      },
    };
    const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    new Function("window", script)(hostWindow);
    expect(hostWindow.require("electron").app.getVersion()).toBe(packageInfo.version);
    expect(hostWindow.require("fs")).toBe(other);
    await hostWindow.require("electron").shell.openExternal("https://example.invalid");
    expect(hostWindow.utools.shellOpenExternal).toHaveBeenCalledWith("https://example.invalid");
    const capturedRequire = hostWindow.require;
    expect(capturedRequire("electron")).toBe(hostWindow.require("electron"));
  });

  it("routes all four serialized shell methods exclusively to their existing host counterparts", async () => {
    const shellOpenExternal = vi.fn(async () => null), shellOpenPath = vi.fn(async () => null);
    const shellShowItemInFolder = vi.fn(async () => null), shellTrashItem = vi.fn(async () => null);
    const { electron, error } = installSerializedAdapter({ shellOpenExternal, shellOpenPath, shellShowItemInFolder, shellTrashItem });
    await expect(electron.shell.openExternal("https://example.invalid")).resolves.toBeUndefined();
    await expect(electron.shell.openPath("/tmp/open")).resolves.toBe("");
    expect(electron.shell.showItemInFolder("/tmp/reveal ")).toBeUndefined();
    await expect(electron.shell.trashItem("/tmp/trash ")).resolves.toBeUndefined();
    expect(shellOpenExternal.mock.calls).toEqual([["https://example.invalid"]]);
    expect(shellOpenPath.mock.calls).toEqual([["/tmp/open"]]);
    expect(shellShowItemInFolder.mock.calls).toEqual([["/tmp/reveal "]]);
    expect(shellTrashItem.mock.calls).toEqual([["/tmp/trash "]]);
    expect(error).not.toHaveBeenCalled();
  });

  it("routes the serialized open-external IPC alias through the existing authorized shell method", async () => {
    const shellOpenExternal = vi.fn(async () => null);
    const { electron } = installSerializedAdapter({ shellOpenExternal });
    await expect(electron.ipcRenderer.invoke("open-external", "https://example.invalid/from-ipc")).resolves.toBeUndefined();
    expect(shellOpenExternal.mock.calls).toEqual([["https://example.invalid/from-ipc"]]);
    await expect(electron.ipcRenderer.invoke("custom", "https://example.invalid")).rejects.toThrow("UNSUPPORTED");
    await expect(electron.ipcRenderer.invoke("open-external", "https://example.invalid", {})).rejects.toThrow();
    expect(shellOpenExternal).toHaveBeenCalledOnce();

    const denied = new Error("Permission denied");
    shellOpenExternal.mockRejectedValueOnce(denied);
    await expect(electron.ipcRenderer.invoke("open-external", "https://example.invalid/denied")).rejects.toBe(denied);
    expect(shellOpenExternal).toHaveBeenCalledTimes(2);
  });

  it("observes serialized reveal failure and propagates serialized trash cancellation without fallback or replay", async () => {
    const denied = { code: "PERMISSION_DENIED" }, canceled = new Error("Canceled by user");
    const shellOpenPath = vi.fn(async () => null);
    const shellShowItemInFolder = vi.fn(async () => { throw denied; });
    const shellTrashItem = vi.fn(async () => { throw canceled; });
    const { electron, error } = installSerializedAdapter({ shellOpenPath, shellShowItemInFolder, shellTrashItem });
    expect(electron.shell.showItemInFolder("/tmp/reveal")).toBeUndefined();
    await expect(electron.shell.trashItem("/tmp/trash")).rejects.toBe(canceled);
    await settle();
    expect(error.mock.calls).toEqual([["[ATools electron shell.showItemInFolder]", denied]]);
    expect(shellShowItemInFolder).toHaveBeenCalledOnce();
    expect(shellTrashItem).toHaveBeenCalledOnce();
    expect(shellOpenPath).not.toHaveBeenCalled();
  });

  it("never redirects missing serialized shell methods to openPath", async () => {
    const shellOpenPath = vi.fn(async () => null);
    const { electron, error } = installSerializedAdapter({ shellOpenPath });
    expect(electron.shell.showItemInFolder("/tmp/reveal")).toBeUndefined();
    await expect(electron.shell.trashItem("/tmp/trash")).rejects.toThrow("UNSUPPORTED: shellTrashItem");
    await settle();
    expect(error.mock.calls[0][0]).toBe("[ATools electron shell.showItemInFolder]");
    expect(error.mock.calls[0][1].message).toContain("UNSUPPORTED: shellShowItemInFolder");
    expect(shellOpenPath).not.toHaveBeenCalled();
  });
});
