import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, ZToolsImportCandidate, ZToolsImportReport } from "../../src/lib/types";
import { ZToolsImportController, type ZToolsImportServices, type ZToolsImportState } from "../../src/lib/ztoolsImportController";

function candidate(path: string, name: string, readiness: string | null = "ready"): ZToolsImportCandidate {
  return { path, source_type: "directory", entry_readiness: readiness, name, title: name, version: "1", features_count: 1,
    platform_supported: true, main_exists: true, preload_exists: false, logo_exists: false, unsupported_cmd_types: [], warnings: [], errors: [] };
}
function imported(id: string, enabled = true): InstalledPlugin {
  return { id, name: id, version: "1", enabled, path: `/plugins/${id}`, created_at: "", updated_at: "",
    manifest: { title: id, main: "index.html", features: [{ code: "open-me" }] } };
}
function report(overrides: Partial<ZToolsImportReport> = {}): ZToolsImportReport { return { imported: [], skipped: [], failed: [], ...overrides }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides: Partial<ZToolsImportServices> = {}) {
  let state!: ZToolsImportState;
  const source = candidate("/source/a", "alpha");
  const services: ZToolsImportServices = {
    scanDefault: vi.fn(async () => [source]), scanPath: vi.fn(async () => [source]),
    chooseDirectory: vi.fn(async () => "/picked"), chooseArchive: vi.fn(async () => "/picked.zip"),
    importPaths: vi.fn(async () => report()), listPlugins: vi.fn(async () => []), enablePlugin: vi.fn(async () => {}),
    ...overrides,
  };
  const controller = new ZToolsImportController(services, next => { state = next; });
  return { controller, services, get state() { return state; }, source };
}

describe("ZTools import transaction controller", () => {
  it("selects only selectable candidates, including candidates without errors but blocked by readiness", async () => {
    const ready = candidate("/source/ready", "ready");
    const blocked = candidate("/source/build", "build", "requires_build");
    const h = harness({ scanDefault: vi.fn(async () => [ready, blocked]) });
    await h.controller.scanDefault();
    expect(h.state.selected).toEqual(new Set([ready.path]));
  });

  it("preserves old candidates and selection after a subsequent scan fails", async () => {
    const h = harness();
    await h.controller.scanDefault();
    h.controller.clearSelection();
    vi.mocked(h.services.scanDefault).mockRejectedValueOnce(new Error("disk unavailable"));
    await h.controller.scanDefault();
    expect(h.state.candidates).toEqual([h.source]);
    expect(h.state.selected).toEqual(new Set());
    expect(h.state.error).toContain("扫描失败：disk unavailable");
  });

  it("keeps scan and picker mutually exclusive, including the native chooser's pending lifetime", async () => {
    const picker = deferred<string | null>();
    const scan = vi.fn(async () => [harness().source]);
    const h = harness({ chooseDirectory: vi.fn(() => picker.promise), scanDefault: scan });
    const choosing = h.controller.chooseDirectory();
    await h.controller.scanDefault();
    expect(scan).not.toHaveBeenCalled();
    expect(h.state.busy).toBe("choosing-directory");
    picker.resolve(null);
    await choosing;
    expect(h.state.busy).toBe("idle");
  });

  it("imports a frozen path batch once, removes only successful and skipped sources, and retries only failures", async () => {
    const a = candidate("/source/a", "alpha");
    const b = candidate("/source/b", "beta");
    const c = candidate("/source/c", "gamma");
    const failed = { path: b.path, error: "temporary failure" };
    const skipped = candidate("/source/c", "gamma");
    const importPaths = vi.fn().mockResolvedValueOnce(report({ imported: ["alpha"], skipped: [skipped], failed: [failed] }))
      .mockResolvedValueOnce(report({ imported: ["beta"], failed: [] }));
    const h = harness({ scanDefault: vi.fn(async () => [a, b, c]), importPaths });
    await h.controller.scanDefault();
    const first = h.controller.importSelected();
    h.controller.toggle(a.path, false);
    await first;
    expect(importPaths.mock.calls[0][0]).toEqual([a.path, b.path, c.path]);
    expect(h.state.selected).toEqual(new Set([b.path]));
    expect(h.state.report?.failed.map(item => item.path)).toEqual([b.path]);
    await h.controller.retryFailures();
    expect(importPaths.mock.calls[1][0]).toEqual([b.path]);
    expect(h.state.selected).toEqual(new Set());
    expect(h.state.report?.imported).toEqual(["alpha", "beta"]);
    expect(h.state.report?.failed).toEqual([]);
  });

  it("uses exact failed source paths for partial success even when imported IDs collide after sanitizing", async () => {
    const unique = candidate("/source/unique", "my.plugin");
    const collisionA = candidate("/source/one", "same-name");
    const collisionB = candidate("/source/two", "same.name");
    const h = harness({ scanDefault: vi.fn(async () => [unique, collisionA, collisionB]), importPaths: vi.fn(async () => report({
      imported: ["my-plugin", "same-name"], failed: [{ path: collisionB.path, error: "partial failure" }],
    })) });
    await h.controller.scanDefault();
    await h.controller.importSelected();
    expect(h.state.selected).toEqual(new Set([collisionB.path]));
  });

  it("keeps import success when list_plugins fails and recovers by reading without another import", async () => {
    const listPlugins = vi.fn().mockRejectedValueOnce(new Error("catalog offline")).mockResolvedValueOnce([imported("alpha")]);
    const importPaths = vi.fn(async () => report({ imported: ["alpha"] }));
    const h = harness({ listPlugins, importPaths });
    await h.controller.scanDefault();
    await h.controller.importSelected();
    expect(h.state.report?.imported).toEqual(["alpha"]);
    expect(h.state.refreshError).toContain("catalog offline");
    await h.controller.retryPluginList();
    expect(h.state.importedPlugins.alpha.enabled).toBe(true);
    expect(importPaths).toHaveBeenCalledTimes(1);
  });

  it("enables a disabled imported plugin through native state, retries enable separately, then reads actual state", async () => {
    const enablePlugin = vi.fn().mockRejectedValueOnce(new Error("activation not ready")).mockResolvedValueOnce(undefined);
    const listPlugins = vi.fn().mockResolvedValue([imported("alpha", true)]);
    const importPaths = vi.fn(async () => report({ imported: ["alpha"] }));
    const h = harness({ enablePlugin, listPlugins, importPaths });
    await h.controller.scanDefault();
    await h.controller.importSelected();
    // The initial refresh reports the persisted disabled record.
    listPlugins.mockResolvedValueOnce([imported("alpha", false)]);
    await h.controller.retryPluginList();
    expect(h.state.importedPlugins.alpha.enabled).toBe(false);
    await h.controller.enableAndRefresh("alpha");
    expect(h.state.enableErrors.alpha).toContain("activation not ready");
    await h.controller.enableAndRefresh("alpha");
    expect(enablePlugin).toHaveBeenCalledTimes(2);
    expect(h.state.importedPlugins.alpha.enabled).toBe(true);
    expect(importPaths).toHaveBeenCalledTimes(1);
  });

  it("keeps the persisted disabled record if enable succeeds but refresh fails, then recovers with list-only retry", async () => {
    const listPlugins = vi.fn().mockResolvedValueOnce([imported("alpha", false)])
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce([imported("alpha", true)]);
    const enablePlugin = vi.fn(async () => {});
    const importPaths = vi.fn(async () => report({ imported: ["alpha"] }));
    const h = harness({ listPlugins, enablePlugin, importPaths });
    await h.controller.scanDefault();
    await h.controller.importSelected();
    expect(h.state.importedPlugins.alpha.enabled).toBe(false);
    await h.controller.enableAndRefresh("alpha");
    expect(h.state.importedPlugins.alpha.enabled).toBe(false);
    expect(h.state.refreshError).toContain("插件已启用，但读取插件列表失败");
    expect(h.state.pendingEnableRefresh.has("alpha")).toBe(true);
    await h.controller.retryEnabledPluginList("alpha");
    expect(h.state.importedPlugins.alpha.enabled).toBe(true);
    expect(h.state.pendingEnableRefresh.has("alpha")).toBe(false);
    expect(enablePlugin).toHaveBeenCalledTimes(1);
    expect(importPaths).toHaveBeenCalledTimes(1);
  });

  it("ignores scan results after disposal without pretending an in-flight native import was cancelled", async () => {
    const pending = deferred<ZToolsImportCandidate[]>();
    const h = harness({ scanDefault: vi.fn(() => pending.promise) });
    const scan = h.controller.scanDefault();
    h.controller.dispose();
    pending.resolve([h.source]);
    await scan;
    expect(h.state.candidates).toEqual([]);
  });
});
