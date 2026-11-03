import { expect, it, vi } from "vitest";
import { createPluginRuntimeControl } from "../../src/lib/pluginRuntimeControl";
import { runtimeSessionId, type RuntimeSession } from "../../src/lib/pluginRuntimeInventory";
function row(instanceId = "original"): RuntimeSession {
  return { id: runtimeSessionId("background", "main", instanceId), kind: "background", instanceId,
    pluginId: "harris-sample", windowLabel: "main", codeRevision: "a".repeat(64), phase: "ready", evidence: "renderer_view" };
}

it("coalesces exact stops and waits for disappearance instead of a callback receipt", async () => {
  const control = createPluginRuntimeControl(); let rows = [row()]; let finish!: () => void;
  const stop = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; }); rows = []; });
  control.registerSource("host", { snapshot: () => rows, stop });
  const first = control.stop(row()), duplicate = control.stop(row());
  expect(first).toBe(duplicate);
  await Promise.resolve(); expect(stop).toHaveBeenCalledOnce(); expect(control.snapshot()).toHaveLength(1);
  finish(); await first; expect(control.snapshot()).toEqual([]);
});

it("retains an unconfirmed resource after a swallowed failure", async () => {
  const control = createPluginRuntimeControl(); const rows = [row()];
  control.registerSource("host", { snapshot: () => rows, stop: async () => {} });
  await expect(control.stop(row())).rejects.toThrow("ERR_PLUGIN_RUNTIME_STOP_UNCONFIRMED");
  expect(control.snapshot()).toEqual(rows);
});

it("refuses stale revision, new instance, replaced source, and calls after disposal", async () => {
  const control = createPluginRuntimeControl(); let rows = [row()]; const stop = vi.fn(async () => { rows = []; });
  const release = control.registerSource("host", { snapshot: () => rows, stop });
  await expect(control.stop({ ...row(), codeRevision: "b".repeat(64) })).rejects.toThrow("STALE");
  rows = [row("replacement")]; await expect(control.stop(row())).rejects.toThrow("STALE");
  rows = [row()]; const waiting = control.stop(row()); release();
  await expect(waiting).rejects.toThrow("STALE"); expect(stop).not.toHaveBeenCalled();
  control.dispose(); await expect(control.stop(row())).rejects.toThrow("STALE"); expect(control.snapshot()).toEqual([]);
});

it("does not enable an administrative stop for read-only native observations", () => {
  const control = createPluginRuntimeControl();
  expect(control.canStop(row())).toBe(false);
  const source = { snapshot: () => [row()], stop: async () => {} };
  const release = control.registerSource("host", source);
  expect(control.canStop(row())).toBe(true);
  expect(control.canStop({ ...row(), evidence: "admission" })).toBe(false);
  expect(control.canStop({ ...row(), phase: "cleanup_failed" })).toBe(false);
  release(); expect(control.canStop(row())).toBe(false);
});
