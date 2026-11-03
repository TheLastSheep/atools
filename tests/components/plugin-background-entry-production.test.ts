// @vitest-environment node
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { createPluginPanelSessionLifecycle, type PluginPanelSessionLifecyclePorts } from "../../src/lib/pluginPanelSessionLifecycle";
import type { FeatureAction } from "../../src/lib/types";

it("routes real host FeatureActions into the compiled frame without disposing on hide", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only", url: "https://background-entry.fixture.invalid/",
  });
  const frame = dom.window as JSDOM["window"] & Record<string, any>;
  const boot: FeatureAction = { plugin_id: "entry-fixture", plugin_name: "Entry fixture", feature_code: "",
    main_url: "index.html", plugin_path: "/fixture/entry", expand_height: 0, payload: null, auto_detach: false };
  const entered: unknown[] = [], generic: unknown[] = [], exits: boolean[] = [];
  const messages: Record<string, unknown>[] = [];
  const closeResources = vi.fn(async () => {});
  let generation = 1, outDispatched = false;
  const post = (_source: unknown, message: unknown) => {
    messages.push(message as Record<string, unknown>);
    const event = new frame.MessageEvent("message", { data: message, origin: frame.location.origin });
    Object.defineProperty(event, "source", { value: frame.parent });
    frame.dispatchEvent(event);
    return true;
  };
  // Native resources are explicit controlled ports; the parent lifecycle and
  // compiled frame implementations below are both the production modules.
  const ports = {
    action: () => boot, documentPluginId: boot.plugin_id, persistentSessionId: "11111111-1111-4111-8111-111111111111",
    workerDocument: { cancel: vi.fn(), shutdown: vi.fn(async () => ({ requested: 0, acknowledged: 0, timedOut: false })) },
    nextGeneration: () => ++generation, currentGeneration: () => generation,
    retry: { invalidate: vi.fn() }, clearPermissionRequests: vi.fn(),
    mainPushHost: { close: vi.fn() }, mainPushPermissions: { close: vi.fn() },
    webStorageRelay: { close: vi.fn() }, resolveDestroyedSmokeProbe: vi.fn(),
    hostedIpc: { clear: vi.fn() }, sources: { clear: vi.fn() },
    destroyBrowserWindows: vi.fn(async () => {}), closeResourcesStrict: closeResources,
    iframeWindow: () => frame, post, wasOutDispatched: () => outDispatched,
    setOutDispatched: (value: boolean) => { outDispatched = value; },
    resetEntry: vi.fn(), setVisible: vi.fn(),
  } as unknown as PluginPanelSessionLifecyclePorts;

  try {
    Object.assign(frame, { TextEncoder, TextDecoder, Buffer });
    Object.defineProperty(frame, "postMessage", { value: vi.fn(), configurable: true });
    const html = createPluginBridgeDocument({ action: boot, entryMode: "preload", windowType: "main",
      browserWindowId: "", geometrySnapshot: null, workerScope: "entry-fixture", mainPushConfig: null,
      webContentsId: 201, subInputEpoch: 0, appName: "ATools entry fixture", appVersion: "test" });
    const document = new frame.DOMParser().parseFromString(html, "text/html");
    for (const script of [...document.querySelectorAll("script")]) frame.eval(script.textContent ?? "");
    frame.exports = { selected: { mode: "list", args: { enter: (action: unknown) => entered.push(action) } } };
    frame.ztools.onPluginReady((action: unknown) => generic.push(action));
    frame.ztools.onPluginOut((isKill: boolean) => exits.push(isKill));

    const lifecycle = createPluginPanelSessionLifecycle(ports);
    const selected: FeatureAction = { ...boot, feature_code: "selected", entry_type: "regex", payload: { exact: "保留😀" } };
    expect(await lifecycle.activatePersistentEntry(selected)).toBe(true);
    expect(entered).toEqual([{ code: "selected", type: "regex", payload: selected.payload, from: "main" }]);
    expect(generic).toEqual([]);
    await lifecycle.setPersistentVisible(false);
    expect(exits).toEqual([false]);
    expect(closeResources).not.toHaveBeenCalled();
    expect(await lifecycle.activatePersistentEntry(selected)).toBe(true);
    expect(entered).toHaveLength(2);
    expect(generic).toEqual([]);

    const ordinary: FeatureAction = { ...boot, feature_code: "ordinary", entry_type: "over", payload: "same document" };
    expect(await lifecycle.activatePersistentEntry(ordinary)).toBe(true);
    expect(generic).toEqual([{ code: "ordinary", type: "over", payload: "same document", from: "main" }]);
    expect(messages.filter(message => message.event === "plugin-enter").map(message => message.activationId)).toEqual([1, 2, 3]);
    await lifecycle.destroyStrict();
    expect(closeResources).toHaveBeenCalledOnce();
    expect(exits).toEqual([false, true]);
    expect(await lifecycle.activatePersistentEntry(selected)).toBe(false);
    expect(entered).toHaveLength(2);
  } finally { dom.window.close(); }
});
