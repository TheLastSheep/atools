import { MessageChannel as RealMessageChannel } from "node:worker_threads";
import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginPanel from "../../src/components/PluginPanel.svelte";
import { createPluginPanelDocumentHost } from "../../src/lib/pluginPanelDocumentHost";
import { readPluginFrameBootstrapObservation } from "../../src/lib/pluginFrameBootstrapObservation";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import type { FeatureAction } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readTextFile: vi.fn(), listener: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: mocks.readTextFile }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listener }));
const id = "12345678-1234-4234-9234-123456789abc", origin = `atools-page://${id.replaceAll("-", "")}.localhost`;
const page = { pageDocumentId: id, expectedOrigin: origin, parentOrigin: window.location.origin,
  bootstrapUrl: `${origin}/${"b".repeat(32)}/bootstrap.html`, resourceBaseUrl: `${origin}/assets/` };
const action: FeatureAction = { plugin_id: "document-fixture", plugin_name: "合成文档插件", feature_code: "open",
  plugin_path: "/synthetic/document-fixture", main_url: "index.html", expand_height: 400, payload: null };
const ports: MessagePort[] = [];
beforeEach(() => {
  vi.stubEnv("VITE_ATOOLS_PLUGIN_PAGE_DOCUMENT", "true");
  vi.stubGlobal("MessageChannel", RealMessageChannel);
  mocks.invoke.mockReset(); mocks.readTextFile.mockReset();
  mocks.listener.mockReset(); mocks.listener.mockResolvedValue(() => {});
  mocks.readTextFile.mockResolvedValue("<!doctype html><html><head></head><body>synthetic original UI</body></html>");
  mocks.invoke.mockImplementation(async command => {
    if (command === "prepare_plugin_page") return page;
    if (command === "native_panel_document_probe_source") return "/* passive fixture observer */";
    if (String(command).startsWith("prepare_")) return { unavailable: true, usage: "not_detected" };
    return undefined;
  });
});
afterEach(() => { cleanup(); ports.splice(0).forEach(port => port.close()); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function deliver(frame: HTMLIFrameElement) {
  const source = frame.contentWindow!, nonce = "c".repeat(32);
  let peer!: MessagePort, binding!: Record<string, unknown>, payload: { html: string } | undefined;
  vi.spyOn(source, "postMessage").mockImplementation(((data: Record<string, unknown>, target: string, transfer: MessagePort[]) => {
    expect(target).toBe(origin); expect(data).not.toHaveProperty("html");
    binding = { runId: data.runId, id: data.id, docNonce: data.docNonce, generation: data.generation };
    peer = transfer[0]; ports.push(peer);
    peer.onmessage = event => { payload = event.data; }; peer.start();
    peer.postMessage({ kind: "atools-bootstrap-ack", ...binding });
  }) as never);
  window.dispatchEvent(new MessageEvent("message", { source, origin, data: { kind: "atools-bootstrap-hello", runId: id, id, docNonce: nonce } }));
  frame.dispatchEvent(new Event("load"));
  await waitFor(() => expect(payload?.html).toContain("synthetic original UI"));
  const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", { source, origin,
    data: { ...data, ...binding, __atoolsDocument: { pageDocumentId: id, docNonce: nonce, generation: binding.generation } } }));
  return { send, html: payload!.html };
}

it("delivers through the actual panel once and treats early outPlugin as a successful output transition", async () => {
  const onready = vi.fn(), onloaderror = vi.fn();
  render(PluginPanel, { action: { ...action, plugin_permissions: [] }, onclose: vi.fn(), onready, onloaderror });
  const frame = await waitFor(() => {
    const value = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    expect(value?.getAttribute("src")).toBe(page.bootstrapUrl); return value!;
  });
  expect(frame.srcdoc).toBe(""); expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  const delivered = await deliver(frame);
  delivered.send({ __atools_permission_request__: true, reqId: 17, permission: "clipboard.write",
    pluginId: action.plugin_id, featureCode: action.feature_code });
  await screen.findByRole("dialog", { name: "插件运行时权限请求" });
  // Original onPluginEnter can emit output before the injected DOM-ready callback.
  delivered.send({ __ipc_out__: true, data: [{ title: "即时结果", description: "synthetic" }] });
  await waitFor(() => expect(screen.getByText("即时结果")).toBeTruthy());
  await waitFor(() => expect(onready).toHaveBeenCalledTimes(1));
  expect(onloaderror).not.toHaveBeenCalled(); expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
  expect(screen.queryByRole("dialog", { name: "插件运行时权限请求" })).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "claim_plugin_page")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "close_plugin_page")).toBe(true);
});

it("observes the current mounted bootstrap and revokes the snapshot when that panel closes", async () => {
  vi.stubEnv("VITE_ATOOLS_PAGE_NAVIGATION_OBSERVATION", "true");
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const frame = await waitFor(() => {
    const value = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    expect(value?.getAttribute("src")).toBe(page.bootstrapUrl); return value!;
  });
  const read = () => readPluginFrameBootstrapObservation(frame, frame.contentWindow!, id);
  expect(read()).toMatchObject({ phase: "awaiting-hello", bootstrapLoad: false, ackReceived: false });
  const delivered = await deliver(frame);
  expect(read()).toMatchObject({ phase: "delivered", bootstrapLoad: true, ackReceived: true });
  delivered.send({ kind: "atools-bootstrap-payload-ready" });
  await waitFor(() => expect(read()).toMatchObject({ phase: "ready", payloadLoad: false, ackReceived: true }));
  view.unmount();
  expect(read()).toBeNull();
});

it("mounts a fresh document when reopening after a previous output", async () => {
  const view = render(PluginPanel, { action, onclose: vi.fn() });
  const first = await waitFor(() => { const f = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'); expect(f).toBeTruthy(); return f!; });
  (await deliver(first)).send({ __ipc_out__: true, data: [{ title: "旧结果" }] });
  await screen.findByText("旧结果");
  await view.rerender({ action: { ...action, feature_code: "second" }, onclose: vi.fn() });
  const next = await waitFor(() => { const f = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'); expect(f).toBeTruthy(); expect(f).not.toBe(first); return f!; });
  const nextDelivery = await deliver(next);
  nextDelivery.send({ kind: "atools-bootstrap-payload-ready" });
  await waitFor(() => expect(screen.queryByText("旧结果")).toBeNull());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_plugin_page")).toHaveLength(2);
});

it("keeps a persistent boot document fixed when the action prop changes", async () => {
  const persistentSessionId = "87654321-4321-4321-8321-cba987654321";
  const view = render(PluginPanel, { action, persistentSessionId, persistentVisible: true, onclose: vi.fn() });
  const first = await waitFor(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    expect(frame?.getAttribute("src")).toBe(page.bootstrapUrl);
    return frame!;
  });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_plugin_page")).toHaveLength(1);

  await view.rerender({ action: { ...action, feature_code: "imperative-entry-only" }, persistentSessionId,
    persistentVisible: true, onclose: vi.fn() });

  expect(document.querySelector('iframe[title="Plugin"]')).toBe(first);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "prepare_plugin_page")).toHaveLength(1);
});

it("bounds staging if no iframe ever mounts and drains the prepared native document", async () => {
  vi.useFakeTimers();
  const onFailure = vi.fn();
  const host = createPluginPanelDocumentHost({ invoke: mocks.invoke as never, pluginId: action.plugin_id,
    pluginRoot: action.plugin_path, parentOrigin: page.parentOrigin, isCurrent: () => true, sources: new PluginFrameSourceRegistry(), onFailure });
  await host.prepare(); expect(host.stage("private payload")).toBe(page.bootstrapUrl);
  await vi.advanceTimersByTimeAsync(5000);
  await expect(host.ready).rejects.toThrow("CLOSED");
  expect(onFailure).toHaveBeenCalledTimes(1); expect(onFailure.mock.calls[0][0].message).toContain("MOUNT_TIMEOUT");
  expect(mocks.invoke).toHaveBeenLastCalledWith("close_plugin_page", expect.objectContaining({ pageDocumentId: id }));
  expect(() => host.stage("retry")).toThrow("STAGE");
});

it("removes a pending permission and frame when the matching native navigation event arrives", async () => {
  let receive!: (event: { payload: unknown }) => void;
  const stop = vi.fn(); mocks.listener.mockImplementation(async (event, listener) => {
    if (event === "plugin-page-revoked") { receive = listener; return stop; }
    return () => {};
  });
  render(PluginPanel, { action: { ...action, plugin_permissions: [] }, onclose: vi.fn() });
  const frame = await waitFor(() => { const f = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'); expect(f).toBeTruthy(); return f!; });
  const delivered = await deliver(frame); delivered.send({ kind: "atools-bootstrap-payload-ready" });
  delivered.send({ __atools_permission_request__: true, reqId: 18, permission: "clipboard.write",
    pluginId: action.plugin_id, featureCode: action.feature_code });
  await screen.findByRole("dialog", { name: "插件运行时权限请求" });
  receive({ payload: { pageDocumentId: "foreign", reason: "navigation" } });
  expect(document.querySelector('iframe[title="Plugin"]')).toBe(frame);
  receive({ payload: { pageDocumentId: id, reason: "navigation" } });
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')).toBeNull());
  expect(screen.queryByRole("dialog", { name: "插件运行时权限请求" })).toBeNull();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("插件页面已失效");
});
