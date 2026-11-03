import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZToolsImportController, type ZToolsImportServices } from "../../src/lib/ztoolsImportController";
import type { InstalledPlugin } from "../../src/lib/types";

function setup() {
  let late: (value: InstalledPlugin[]) => void = () => {};
  const listPlugins = vi.fn(() => new Promise<InstalledPlugin[]>(resolve => { late = resolve; }));
  const services: ZToolsImportServices = { listPlugins, scanDefault: async () => [], scanPath: async () => [],
    chooseDirectory: async () => null, chooseArchive: async () => null,
    importPaths: async () => ({ imported: [], failed: [], skipped: [] }), enablePlugin: async () => {} };
  const changed = vi.fn();
  const controller = new ZToolsImportController(services, changed);
  return { controller, changed, listPlugins, late: (plugins: InstalledPlugin[]) => late(plugins) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("preserves a completed conversion and releases panel busy when catalog reading never settles", async () => {
  const f = setup();
  const refresh = f.controller.registerConvertedPlugin("converted");
  expect(f.controller.snapshot.busy).toBe("refreshing");
  await vi.advanceTimersByTimeAsync(5000);
  await refresh;
  expect(f.controller.snapshot.busy).toBe("idle");
  expect(f.controller.snapshot.report?.imported).toEqual(["converted"]);
  expect(f.controller.snapshot.refreshError).toContain("转换并安装已完成");
  expect(f.controller.snapshot.refreshError).toContain("超时");
  f.late([{ id: "converted", enabled: false } as InstalledPlugin]);
  await Promise.resolve();
  expect(f.controller.snapshot.importedPlugins).toEqual({});
  f.listPlugins.mockResolvedValue([{ id: "converted", enabled: true } as InstalledPlugin]);
  await f.controller.retryPluginList();
  expect(f.controller.snapshot.importedPlugins.converted.enabled).toBe(true);
  expect(f.controller.snapshot.refreshError).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  f.controller.dispose();
});

it("disposal drains pending observation immediately and ignores its eventual native reply", async () => {
  const f = setup();
  const refresh = f.controller.registerConvertedPlugin("converted");
  await Promise.resolve();
  f.controller.dispose();
  await refresh;
  const changes = f.changed.mock.calls.length;
  f.late([{ id: "converted" } as InstalledPlugin]);
  await Promise.resolve();
  expect(f.changed).toHaveBeenCalledTimes(changes);
  expect(vi.getTimerCount()).toBe(0);
});
