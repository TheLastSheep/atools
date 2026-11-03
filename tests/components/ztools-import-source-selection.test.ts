import { describe, expect, it, vi } from "vitest";
import type { ZToolsImportCandidate, ZToolsImportReport, ZToolsImportFailure } from "../../src/lib/types";
import { ZToolsImportController, type ZToolsImportServices } from "../../src/lib/ztoolsImportController";
import { groupImportCandidates, retryImportPaths, safeImportPaths, selectUnambiguousImportSources, toggleImportSource } from "../../src/lib/ztoolsImportSelection";
import { ztoolsImportView } from "../../src/lib/ztoolsImportView";

function candidate(path: string, overrides: Partial<ZToolsImportCandidate> = {}): ZToolsImportCandidate {
  return { path, source_type: "directory", entry_readiness: "ready", name: "same.plugin", installation_id: "same-plugin",
    title: "同名插件", version: "1.0.0", features_count: 1, platform_supported: true, main_exists: true,
    preload_exists: true, logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [], ...overrides };
}
const source = candidate("/plugins/source", { entry_readiness: "requires_build" });
const archive = candidate("/plugins/source/release.zpx", { source_type: "zpx", version: "0.9.0" });
const alternate = candidate("/plugins/other/release.zip", { source_type: "zip", version: "2.0.0" });
const unique = candidate("/plugins/unique", { name: "unique", installation_id: "unique" });
const report = (failed: ZToolsImportFailure[] = []): ZToolsImportReport => ({ imported: [], skipped: [], failed });

function harness(candidates: ZToolsImportCandidate[], overrides: Partial<ZToolsImportServices> = {}) {
  const services: ZToolsImportServices = {
    scanDefault: vi.fn(async () => candidates), scanPath: vi.fn(async () => candidates),
    chooseDirectory: vi.fn(async () => null), chooseArchive: vi.fn(async () => null),
    importPaths: vi.fn(async () => report()), listPlugins: vi.fn(async () => []), enablePlugin: vi.fn(async () => {}), ...overrides,
  };
  return { controller: new ZToolsImportController(services, () => {}), services };
}

describe("ZTools source selection identity", () => {
  it("requires an explicit choice even when a source has only one usable archive", () => {
    expect(selectUnambiguousImportSources([source, archive, unique])).toEqual(new Set([unique.path]));
    expect(selectUnambiguousImportSources([archive, alternate])).toEqual(new Set());
  });

  it("groups backend installation ID collisions without deriving IDs from display or manifest names", () => {
    const a = candidate("/a", { name: "same.name" });
    const b = candidate("/b", { name: "same-name" });
    expect(groupImportCandidates([a, b]).size).toBe(1);
    expect(selectUnambiguousImportSources([a, b])).toEqual(new Set());
  });

  it("uses the host collision key for different IDs without folding case in the frontend", () => {
    const a = candidate("/a", { installation_id: "Calculator", installation_key: "calculator", name: "original-a" });
    const b = candidate("/b", { installation_id: "calculator", installation_key: "calculator", name: "original-b" });
    expect(selectUnambiguousImportSources([a, b])).toEqual(new Set());
    expect(safeImportPaths([a, b], [a.path, b.path])).toEqual([]);
    expect(toggleImportSource([a, b], [a.path], b.path, true)).toEqual(new Set([b.path]));
    expect(selectUnambiguousImportSources([a, b], [b.path])).toEqual(new Set([b.path]));
    expect(retryImportPaths([a, b], [a.path], [b.path])).toEqual([]);
    const oldDtoA = { ...a, installation_key: undefined };
    const oldDtoB = { ...b, installation_key: null };
    expect(selectUnambiguousImportSources([oldDtoA, oldDtoB])).toEqual(new Set([a.path, b.path]));
  });

  it("uses unchanged names for old DTOs, retaining distinct punctuation and casing", () => {
    const a = candidate("/a", { installation_id: undefined, name: "same.name" });
    const b = candidate("/b", { installation_id: null, name: "same-name" });
    const c = candidate("/c", { installation_id: null, name: "Same.name" });
    expect(selectUnambiguousImportSources([a, b, c])).toEqual(new Set([a.path, b.path, c.path]));
    expect(selectUnambiguousImportSources([a, { ...a, path: "/another" }])).toEqual(new Set());
  });

  it("allows choosing one path, replaces its peer, and preserves unrelated choices", () => {
    const candidates = [archive, alternate, unique];
    const first = toggleImportSource(candidates, [unique.path], archive.path, true);
    const second = toggleImportSource(candidates, first, alternate.path, true);
    expect(first).toEqual(new Set([unique.path, archive.path]));
    expect(second).toEqual(new Set([unique.path, alternate.path]));
    expect(toggleImportSource(candidates, second, alternate.path, false)).toEqual(new Set([unique.path]));
  });

  it("select-all preserves an explicit version while leaving other ambiguous groups empty", () => {
    const otherA = candidate("/other-a", { installation_id: "other" });
    const otherB = candidate("/other-b", { installation_id: "other" });
    expect(selectUnambiguousImportSources([source, archive, alternate, unique, otherA, otherB], [alternate.path]))
      .toEqual(new Set([alternate.path, unique.path]));
  });

  it("drops conflicting groups, missing paths and blocked entries at the import boundary", () => {
    expect(safeImportPaths([source, archive, alternate, unique], [source.path, archive.path, alternate.path, unique.path, "/missing"]))
      .toEqual([unique.path]);
    expect(safeImportPaths([archive, unique], [archive.path, archive.path, unique.path])).toEqual([archive.path, unique.path]);
    expect(toggleImportSource([source, archive], [], source.path, true)).toEqual(new Set());
  });

  it("retries only one explicitly chosen failed source and respects a new alternative choice", () => {
    expect(retryImportPaths([archive, alternate, unique], [archive.path, alternate.path, unique.path], [alternate.path]))
      .toEqual([alternate.path, unique.path]);
    expect(retryImportPaths([archive, alternate], [archive.path], [alternate.path])).toEqual([]);
    expect(retryImportPaths([archive, alternate, unique], [archive.path, alternate.path, unique.path], []))
      .toEqual([unique.path]);
  });
});

describe("ZTools source selection transaction and view", () => {
  it("shows source choices and available original archives without hiding market recovery", () => {
    const view = ztoolsImportView([source, archive, alternate, unique], new Set([archive.path, unique.path]));
    expect(view.sourceChoiceCount).toBe(1);
    expect(view.pendingSourceChoices).toBe(0);
    expect(view.rows[0].readinessMessage).toContain("请从候选中选择一个");
    expect(view.rows[0].marketRequest?.pluginName).toBe(source.name);
    expect(view.rows[0].sourceChoiceMessage).toBe("这些来源会安装为同一个插件，请只选一个。");
    expect(view.rows[1].subtitle).toContain("0.9.0 · ZPX");
    expect(view.rows[2].subtitle).toContain("2.0.0 · ZIP");
    expect(ztoolsImportView([source, archive], new Set()).pendingSourceChoices).toBe(1);
  });

  it("does not suggest another blocked or incompatible archive as importable", () => {
    const view = ztoolsImportView([source, { ...archive, platform_supported: false }], new Set());
    expect(view.rows[0].readinessMessage).toContain("需要先获得可运行的发布版");
  });

  it("does not count a conflicting external selection as two importable choices", () => {
    const view = ztoolsImportView([archive, alternate], new Set([archive.path, alternate.path]));
    expect(view.summary.selected).toBe(0);
    expect(view.pendingSourceChoices).toBe(1);
  });

  it("keeps source choice exclusive through scan, select-all, clear and native import", async () => {
    const h = harness([source, archive, alternate, unique]);
    await h.controller.scanDefault();
    expect(h.controller.snapshot.selected).toEqual(new Set([unique.path]));
    h.controller.selectAll();
    expect(h.controller.snapshot.selected).toEqual(new Set([unique.path]));
    h.controller.toggle(archive.path, true);
    h.controller.toggle(alternate.path, true);
    h.controller.selectAll();
    expect(h.controller.snapshot.selected).toEqual(new Set([unique.path, alternate.path]));
    await h.controller.importSelected();
    expect(h.services.importPaths).toHaveBeenCalledWith([alternate.path, unique.path]);
    h.controller.clearSelection(); h.controller.selectAll();
    expect(h.controller.snapshot.selected).toEqual(new Set([unique.path]));
  });

  it("does not revive a failed old archive after the user selects another version", async () => {
    const h = harness([archive, alternate], { importPaths: vi.fn(async () => report([{ path: archive.path, error: "transient" }])) });
    await h.controller.scanDefault();
    h.controller.toggle(archive.path, true);
    await h.controller.importSelected();
    h.controller.toggle(alternate.path, true);
    await h.controller.retryFailures();
    expect(h.services.importPaths).toHaveBeenCalledTimes(1);
    expect(h.controller.snapshot.selected).toEqual(new Set([alternate.path]));
    expect(h.controller.snapshot.error).toContain("其他选择");
  });

  it("rejects a contaminated selection again immediately before calling native import", async () => {
    const h = harness([archive, alternate, unique]);
    await h.controller.scanDefault();
    h.controller.snapshot.selected.add(archive.path);
    h.controller.snapshot.selected.add(alternate.path);
    await h.controller.importSelected();
    expect(h.services.importPaths).toHaveBeenCalledWith([unique.path]);
  });

  it("supersedes an old failed source after importing its replacement, preserving unrelated failures", async () => {
    const importPaths = vi.fn().mockResolvedValueOnce(report([
      { path: archive.path, error: "old archive failed" }, { path: unique.path, error: "unrelated failure" },
    ])).mockResolvedValueOnce({ ...report(), imported: ["same-plugin"] });
    const h = harness([archive, alternate, unique], { importPaths });
    await h.controller.scanDefault();
    h.controller.toggle(archive.path, true);
    await h.controller.importSelected();
    h.controller.toggle(unique.path, false);
    h.controller.toggle(alternate.path, true);
    await h.controller.importSelected();
    expect(h.controller.snapshot.report?.failed).toEqual([{ path: unique.path, error: "unrelated failure" }]);
    await h.controller.retryFailures();
    expect(importPaths.mock.calls[2][0]).toEqual([unique.path]);
  });

  it("never revives a different-ID source sharing the host collision key after a new choice succeeds", async () => {
    const a = { ...archive, installation_id: "Calculator", installation_key: "calculator" };
    const b = { ...alternate, installation_id: "calculator", installation_key: "calculator" };
    const importPaths = vi.fn().mockResolvedValueOnce(report([
      { path: a.path, error: "old version failed" }, { path: unique.path, error: "unrelated failure" },
    ])).mockResolvedValueOnce(report()).mockResolvedValueOnce({ ...report(), imported: [b.installation_id] });
    const h = harness([a, b, unique], { importPaths });
    await h.controller.scanDefault();
    h.controller.toggle(a.path, true);
    await h.controller.importSelected();
    h.controller.toggle(b.path, true);
    h.controller.toggle(unique.path, false);
    await h.controller.retryFailures();
    expect(importPaths.mock.calls[1][0]).toEqual([unique.path]);
    expect(h.controller.snapshot.selected).toEqual(new Set([b.path]));
    await h.controller.importSelected();
    expect(importPaths.mock.calls[2][0]).toEqual([b.path]);
    expect(h.controller.snapshot.report?.failed).toEqual([]);
    await h.controller.retryFailures();
    expect(importPaths).toHaveBeenCalledTimes(3);
  });
});
