import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import PluginRuntimePanel from "../../src/components/PluginRuntimePanel.svelte";
import type { InstalledPlugin } from "../../src/lib/types";
import { runtimeKinds, runtimeSessionId, type RuntimeKind, type RuntimeSession, type RuntimeSnapshot } from "../../src/lib/pluginRuntimeInventory";

const mocks = vi.hoisted(() => ({ control: undefined as unknown, invoke: vi.fn() }));
vi.mock("../../src/lib/pluginRuntimeControl", () => ({ getPluginRuntimeControl: () => mocks.control }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const plugin: InstalledPlugin = { id: "runtime-plugin", name: "Runtime Plugin", version: "1.0.0", path: "/private/plugin",
  enabled: true, manifest: { title: "Runtime Plugin", features: [] }, created_at: "", updated_at: "" };
function row(pluginId: string, instanceId: string, kind: RuntimeKind = "background", revision = "a".repeat(64)): RuntimeSession {
  const windowLabel = "main";
  return Object.freeze({ id: runtimeSessionId(kind, windowLabel, instanceId), kind, instanceId, pluginId, windowLabel,
    codeRevision: revision, phase: "ready", evidence: kind === "legacy_node" ? "node_owner" : "admission" });
}
function snapshot(sessions: readonly RuntimeSession[], unavailable: RuntimeKind[] = [], truncated = false): RuntimeSnapshot {
  return { schemaVersion: 1, sessions, coverage: runtimeKinds.map(kind => ({ kind, available: !unavailable.includes(kind) })), truncated };
}
function controlHarness(initial: RuntimeSession[] = [], stopImplementation?: (row: RuntimeSession) => Promise<void>) {
  let rows = [...initial];
  const listeners = new Set<() => void>();
  const canStop = vi.fn((target: RuntimeSession) => rows.some(current => current.id === target.id
    && current.codeRevision === target.codeRevision && current.pluginId === target.pluginId && current.phase === "ready" && current.kind === "background"));
  const stop = vi.fn(async (target: RuntimeSession) => {
    if (stopImplementation) return stopImplementation(target);
    rows = rows.filter(current => current.id !== target.id || current.codeRevision !== target.codeRevision);
    for (const listener of listeners) listener();
  });
  const control = { snapshot: () => rows, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }, canStop, stop };
  return { control, canStop, stop, update(next: RuntimeSession[]) { rows = [...next]; for (const listener of listeners) listener(); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
afterEach(() => { cleanup(); mocks.control = undefined; mocks.invoke.mockReset(); });

it("shows a read error without leaking native details and keeps local rows", async () => {
  const local = row("runtime-plugin", "window-owner", "legacy_node");
  mocks.control = controlHarness([local]).control;
  mocks.invoke.mockRejectedValue(new Error("private native cause"));
  render(PluginRuntimePanel, { plugins: [plugin] });

  expect((await screen.findByRole("alert")).textContent).toContain("运行状态读取失败");
  expect(screen.getByText("Runtime Plugin")).toBeTruthy();
  expect(screen.getByText(/Node 会话/)).toBeTruthy();
  expect(screen.getByText("主窗口")).toBeTruthy();
  expect(screen.getByText("会话记录")).toBeTruthy();
  expect(document.body.textContent).not.toContain("runtime-plugin");
  expect(document.body.textContent).not.toContain("private native cause");
  expect(screen.queryByRole("button", { name: /停止/ })).toBeNull();
});

it("keeps a stopping row visible until confirmation and then refreshes once", async () => {
  const local = row("runtime-plugin", "background-owner");
  const stopped = deferred<void>();
  const harness = controlHarness([local], () => stopped.promise);
  mocks.control = harness.control;
  mocks.invoke.mockResolvedValueOnce(snapshot([local], ["quickjs"], true)).mockResolvedValueOnce(snapshot([]));
  render(PluginRuntimePanel, { plugins: [plugin] });

  expect(await screen.findByText(/部分运行状态不可用/)).toBeTruthy();
  expect(screen.getByText(/QuickJS 会话/)).toBeTruthy();
  const clicking = fireEvent.click(screen.getByRole("button", { name: "停止 Runtime Plugin" }));
  expect(await screen.findByRole("button", { name: "正在停止 Runtime Plugin" })).toBeTruthy();
  harness.update([]);
  expect(screen.getByText("Runtime Plugin")).toBeTruthy();
  stopped.resolve();
  await clicking;
  await waitFor(() => expect(screen.queryByText("Runtime Plugin")).toBeNull());
  expect(harness.stop).toHaveBeenCalledOnce();
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("retains a failed stop row with fixed copy and does not expose a retry action", async () => {
  const local = row("runtime-plugin", "failed-owner");
  const harness = controlHarness([local], async () => { throw new Error("private stop cause"); });
  mocks.control = harness.control;
  mocks.invoke.mockResolvedValue(snapshot([local]));
  render(PluginRuntimePanel, { plugins: [plugin] });
  await screen.findByRole("button", { name: "停止 Runtime Plugin" });

  await fireEvent.click(screen.getByRole("button", { name: "停止 Runtime Plugin" }));
  expect((await screen.findByText("退出未确认，请刷新查看")).getAttribute("role")).toBe("alert");
  expect(screen.getByText("Runtime Plugin")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "停止 Runtime Plugin" })).toBeNull();
  expect(document.body.textContent).not.toContain("private stop cause");
});

it("does not label a stale stop request as cleanup failure", async () => {
  const local = row("runtime-plugin", "replaced-owner");
  const harness = controlHarness([local], async () => { throw new Error("ERR_PLUGIN_RUNTIME_STALE"); });
  mocks.control = harness.control;
  mocks.invoke.mockResolvedValue(snapshot([local]));
  render(PluginRuntimePanel, { plugins: [plugin] });
  await screen.findByRole("button", { name: "停止 Runtime Plugin" });

  await fireEvent.click(screen.getByRole("button", { name: "停止 Runtime Plugin" }));
  await waitFor(() => {
    expect(screen.queryByText("退出未确认，请刷新查看")).toBeNull();
    expect(screen.getByRole("button", { name: "停止 Runtime Plugin" })).toBeTruthy();
  });
});

it("does not stop a new revision through a button captured for the old row", async () => {
  const oldRow = row("runtime-plugin", "same-instance", "background", "a".repeat(64));
  const currentRow = row("runtime-plugin", "same-instance", "background", "b".repeat(64));
  const harness = controlHarness([oldRow]);
  mocks.control = harness.control;
  mocks.invoke.mockResolvedValue(snapshot([]));
  render(PluginRuntimePanel, { plugins: [plugin] });
  const oldButton = await screen.findByRole("button", { name: "停止 Runtime Plugin" });

  harness.update([currentRow]);
  await waitFor(() => expect(screen.getByRole("button", { name: "停止 Runtime Plugin" })).not.toBe(oldButton));
  expect(document.body.textContent).not.toContain("aaaaaaaa");
  expect(document.body.textContent).not.toContain("bbbbbbbb");
  await fireEvent.click(oldButton);
  expect(harness.canStop).toHaveBeenCalledWith(oldRow);
  expect(harness.stop).not.toHaveBeenCalled();
});

it("uses user-facing window and revision labels without exposing runtime identifiers", async () => {
  const unversioned = Object.freeze({ ...row("runtime-plugin", "agent-owner", "legacy_node"),
    id: runtimeSessionId("legacy_node", null, "agent-owner"), windowLabel: null, codeRevision: null });
  const detached = Object.freeze({ ...row("runtime-plugin", "detached-owner", "browser_window"),
    id: runtimeSessionId("browser_window", "plugin-detach", "detached-owner"), windowLabel: "plugin-detach" });
  const genericWindow = Object.freeze({ ...row("runtime-plugin", "window-owner", "browser_window"),
    id: runtimeSessionId("browser_window", "window-1", "window-owner"), windowLabel: "window-1" });
  mocks.control = controlHarness([unversioned, detached, genericWindow]).control;
  mocks.invoke.mockResolvedValue(snapshot([]));
  render(PluginRuntimePanel, { plugins: [plugin] });

  expect(await screen.findByText("无窗口")).toBeTruthy();
  expect(screen.getByText("载入版本未记录")).toBeTruthy();
  expect(screen.getByText("分离窗口")).toBeTruthy();
  expect(screen.getAllByText("插件窗口")).toHaveLength(3);
  expect(document.body.textContent).not.toContain("agent-owner");
  expect(document.body.textContent).not.toContain("detached-owner");
  expect(document.body.textContent).not.toContain("window-1");
});
