import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { TextDecoder, TextEncoder } from "node:util";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../src/lib/pluginPanelBridgeCompiler";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import { createPluginFileDragController } from "../../src/lib/pluginFileDragController";
import { pluginFileDragBridgeScript } from "../../src/lib/pluginFileDragBridge";
import type { FeatureAction } from "../../src/lib/types";
import { vi } from "vitest";

const action: FeatureAction = {
  plugin_id: "file-drag-fixture",
  plugin_name: "File drag fixture",
  feature_code: "file-drag",
  main_url: "index.html",
  plugin_path: "/fixture/file-drag",
  expand_height: 300,
  payload: null,
};

const frames: JSDOM[] = [];
type Request = { method: string; endpoint: string; asynchronous: boolean; contentType: string; body: string };
type Reply = { status?: number; body?: string; responseURL?: string };

function productionFrame(fileDragEndpoint?: string, reply: Reply = {}, input: string | string[] = "/tmp/drag-me.txt") {
  const requests: Request[] = [];
  const bridge = createPluginBridgeDocument({
    action,
    windowType: "main",
    browserWindowId: "",
    geometrySnapshot: null,
    workerScope: "file-drag-test",
    mainPushConfig: null,
    webContentsId: 1,
    subInputEpoch: 1,
    appName: "ATools",
    appVersion: "3.0.0",
    ...(fileDragEndpoint ? { fileDrag: { endpoint: fileDragEndpoint } } : {}),
  });
  const page = injectPluginBridgeHtml(`<!doctype html><html><head></head><body>
    <script>
      window.__pluginScriptRan = true;
      try { window.__pluginDragResult = window.ztools.startDrag && window.ztools.startDrag(window.__pluginDragInput); }
      catch (error) { window.__pluginDragError = { name: error.name, code: error.code, message: error.message }; }
    </script>
  </body></html>`, bridge);
  const frame = new JSDOM(page, {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperties(window, {
        TextDecoder: { value: TextDecoder },
        TextEncoder: { value: TextEncoder },
        __pluginDragInput: { value: input },
        XMLHttpRequest: { value: class {
          status = 200;
          responseURL = "";
          responseText = "";
          contentType = "";
          method = "";
          endpoint = "";
          asynchronous = true;
          open(method: string, endpoint: string, asynchronous = true) { this.method = method; this.endpoint = endpoint; this.asynchronous = asynchronous; }
          setRequestHeader(name: string, value: string) { if (name.toLowerCase() === "content-type") this.contentType = value; }
          send(body: string) {
            requests.push({ method: this.method, endpoint: this.endpoint, asynchronous: this.asynchronous, contentType: this.contentType, body });
            this.status = reply.status ?? 200;
            this.responseURL = reply.responseURL ?? this.endpoint;
            this.responseText = reply.body ?? '{"ok":true,"result":{"started":true}}';
          }
        } },
      });
    },
  });
  frames.push(frame);
  return { window: frame.window as unknown as Window & {
    ztools: { startDrag?: (paths: string | string[]) => unknown };
    __pluginScriptRan?: boolean; __pluginDragInput?: string | string[]; __pluginDragResult?: unknown;
    __pluginDragError?: { name: string; code?: string; message: string };
  }, requests };
}

afterEach(() => {
  for (const frame of frames.splice(0)) frame.window.close();
});

describe("original-plugin synchronous file drag bridge", () => {
  it("returns undefined synchronously through the production bridge after the host scripts parse", () => {
    const frame = productionFrame("http://127.0.0.1:1234/file-drag/" + "a".repeat(64));

    expect(frame.window.__pluginScriptRan).toBe(true);
    expect(frame.window.__pluginDragResult).toBeUndefined();
    expect(frame.requests).toEqual([{
      method: "POST", endpoint: "http://127.0.0.1:1234/file-drag/" + "a".repeat(64),
      asynchronous: false, contentType: "text/plain", body: '{"paths":["/tmp/drag-me.txt"]}',
    }]);
  });

  it("does not expose fake support when no authorized native session is configured", () => {
    const frame = productionFrame();
    expect(frame.window.__pluginScriptRan).toBe(true);
    expect(frame.window.ztools.startDrag).toBeUndefined();
    expect(frame.requests).toHaveLength(0);
  });

  it("sends deduplicated single and multiple absolute paths as one synchronous request", () => {
    const frame = productionFrame("http://127.0.0.1:1234/file-drag/" + "a".repeat(64), {}, ["/tmp/a", "/tmp/b", "/tmp/a"]);
    expect(frame.window.__pluginScriptRan).toBe(true);
    expect(frame.window.__pluginDragError).toBeUndefined();
    expect(frame.window.__pluginDragResult).toBeUndefined();
    expect(frame.requests).toHaveLength(1);
    expect(frame.requests[0]).toMatchObject({ asynchronous: false, body: '{"paths":["/tmp/a","/tmp/b"]}' });
  });

  it.each([
    ["relative path", "relative/file"],
    ["NUL in path", "/tmp/a\0b"],
    ["too many paths", Array.from({ length: 17 }, (_, index) => `/tmp/${index}`)],
    ["path over 8 KiB", "/" + "a".repeat(8 * 1024)],
    ["path aggregate over 64 KiB", Array.from({ length: 9 }, (_, index) => `/${index}` + "x".repeat(8 * 1024 - 2))],
    ["escaped JSON wire over 64 KiB", Array.from({ length: 10 }, (_, index) => `/${index}` + '"'.repeat(4_000))],
  ])("rejects %s synchronously before any network request", (_label, input) => {
    const frame = productionFrame("http://127.0.0.1:1234/file-drag/" + "a".repeat(64), {}, input as string | string[]);
    expect(frame.window.__pluginScriptRan).toBe(true);
    expect(frame.window.__pluginDragError?.name).toBe("PluginFileDragError");
    expect(frame.requests).toHaveLength(0);
  });

  it.each([
    [{ status: 503 }, "ERR_ATOOLS_FILE_DRAG_TRANSPORT"],
    [{ body: "not-json" }, "ERR_ATOOLS_FILE_DRAG_RESPONSE"],
    [{ body: "x".repeat(4 * 1024 + 1) }, "ERR_ATOOLS_FILE_DRAG_RESPONSE_LIMIT"],
    [{ body: '{"ok":true,"result":{"started":false}}' }, "ERR_ATOOLS_FILE_DRAG_RESPONSE"],
  ] as const)("throws synchronously on native response errors without replaying the call", (reply, code) => {
    const frame = productionFrame("http://127.0.0.1:1234/file-drag/" + "a".repeat(64), reply);
    expect(frame.window.__pluginScriptRan).toBe(true);
    expect(frame.window.__pluginDragError?.code).toBe(code);
    expect(frame.requests).toHaveLength(1);
  });

  it("closes the endpoint on pagehide and serializes a self-contained frame bootstrap", () => {
    const endpoint = "http://127.0.0.1:1234/file-drag/" + "a".repeat(64);
    const frame = productionFrame(endpoint);
    frame.window.dispatchEvent(new frame.window.Event("pagehide"));
    try { frame.window.ztools.startDrag?.("/tmp/after-close"); }
    catch (error) { expect(error).toMatchObject({ code: "ERR_ATOOLS_FILE_DRAG_CLOSED" }); }
    expect(frame.requests).toHaveLength(1);
    const serialized = pluginFileDragBridgeScript({ endpoint });
    expect(serialized).toContain("</script>");
    expect(serialized).not.toMatch(/\b(?:import|require)\s*\(/);
  });
});

describe("file drag session preparation", () => {
  it("prepares only when a collected preload module uses startDrag and ignores child graphs", async () => {
    const onFileDragRequired = vi.fn(async () => {});
    const runtime = createPluginRuntimePreload(async () => ({}), "paste", () => true, async () => {});
    const readTextFile = async (path: string) => path.endsWith("preload.js")
      ? "module.exports = require('./native-file-drag')"
      : "exports.drag = function(paths) { return window.ztools.startDrag(paths); }";
    const options = {
      pluginDir: "/fixture/paste", preloadPath: "/fixture/paste/preload.js", readTextFile, onFileDragRequired,
    };

    await runtime.prepare(options);
    expect(onFileDragRequired).toHaveBeenCalledTimes(1);
    await runtime.prepareAdditional(options);
    expect(onFileDragRequired).toHaveBeenCalledTimes(1);
    await runtime.prepare({ ...options, onFileDragRequired, readTextFile: async () => "module.exports = 1" });
    expect(onFileDragRequired).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("uses the shared FileRead TaskRun proof before installing the endpoint", async () => {
    const endpoint = "http://127.0.0.1:1234/file-drag/" + "b".repeat(64);
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args]);
      if (command === "prepare_plugin_file_drag") {
        return args?.requestPermission === true
          ? { permission_required: true, runId: "run-1", tool: "plugin.file_drag" }
          : { sessionId: "session-1" };
      }
      if (command === "get_task_run") return {
        id: "run-1", capabilityId: "plugin.file_drag", initiator: { clientId: "atools-ui" }, status: "succeeded", output: {},
      };
      if (command === "get_plugin_file_drag_session") return { endpoint };
      return undefined;
    });
    const controller = createPluginFileDragController({
      invoke: invoke as never, pluginId: "paste", isCurrent: () => true,
      pageDocumentId: () => "page-1", wait: async () => {},
    });

    expect(await controller.prepare()).toEqual({ endpoint });
    expect(calls.filter(([command]) => command === "prepare_plugin_file_drag").map(([, args]) => args)).toEqual([
      { pluginId: "paste", instanceId: controller.instanceId, requestPermission: true, pageDocumentId: "page-1" },
      { pluginId: "paste", instanceId: controller.instanceId, requestPermission: false, pageDocumentId: "page-1" },
    ]);
    expect(calls.some(([command]) => command === "get_plugin_file_drag_session")).toBe(true);
    await controller.close();
    expect(calls.at(-1)?.[0]).toBe("close_plugin_file_drag");
  });

  it("keeps the plugin usable when the TaskRun permission is denied", async () => {
    const status = vi.fn();
    const invoke = vi.fn(async (command: string) => {
      if (command === "prepare_plugin_file_drag") return { permission_required: true, runId: "run-2", tool: "plugin.file_drag" };
      if (command === "get_task_run") return {
        id: "run-2", capabilityId: "plugin.file_drag", initiator: { clientId: "atools-ui" }, status: "cancelled", output: null,
      };
      return undefined;
    });
    const controller = createPluginFileDragController({
      invoke: invoke as never, pluginId: "paste", isCurrent: () => true, onStatus: status, wait: async () => {},
    });

    expect(await controller.prepare()).toBeUndefined();
    expect(controller.configuration()).toBeUndefined();
    expect(controller.status()?.state).toBe("error");
    expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
    expect(invoke.mock.calls.some(([command]) => command === "get_plugin_file_drag_session")).toBe(false);
    await controller.close();
  });
});
