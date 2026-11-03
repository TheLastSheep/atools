import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, ZToolsImportCandidate, ZToolsImportReport } from "../../src/lib/types";
import { ZToolsImportController, type ZToolsImportServices } from "../../src/lib/ztoolsImportController";
import { ZToolsImportSelectionSession } from "../../src/lib/ztoolsImportSelectionSession";

function candidate(path: string, overrides: Partial<ZToolsImportCandidate> = {}): ZToolsImportCandidate {
  return { path, source_type: "zip", installation_id: "calculator", entry_readiness: "ready", name: "calculator",
    title: "计算器", version: "1.0.0", features_count: 1, platform_supported: true, main_exists: true,
    preload_exists: true, logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [], ...overrides };
}
const blocked = candidate("/sources/calculator", { source_type: "directory", entry_readiness: "requires_build" });
const older = candidate("/sources/calculator/old.zip", { version: "0.9.0" });
const newer = candidate("/sources/calculator/new.zip", { version: "2.0.0" });
const candidates = [blocked, older, newer];
const emptyReport: ZToolsImportReport = { imported: [], skipped: [], failed: [] };

function services(found: ZToolsImportCandidate[], installed: InstalledPlugin[] = []) {
  const value: ZToolsImportServices = {
    scanDefault: async () => found,
    scanPath: async () => found,
    chooseDirectory: async () => null,
    chooseArchive: async () => null,
    importPaths: vi.fn(async () => emptyReport),
    listPlugins: vi.fn(async () => installed),
    enablePlugin: async () => {},
  };
  return value;
}
function controller(session: ZToolsImportSelectionSession, found = candidates, installed: InstalledPlugin[] = []) {
  return new ZToolsImportController(services(found, installed), () => {}, session);
}

describe("bounded in-memory import selection session", () => {
  it("restores an explicit same-root choice and revalidates exact safe paths before import", async () => {
    const session = new ZToolsImportSelectionSession();
    const first = controller(session);
    await first.scanPath("/sources");
    first.toggle(older.path, true);
    first.dispose();

    const nextServices = services(candidates);
    const next = new ZToolsImportController(nextServices, () => {}, session);
    await next.scanPath("/sources");
    expect(next.snapshot.selected).toEqual(new Set([older.path]));
    await next.importSelected();
    expect(nextServices.importPaths).toHaveBeenCalledWith([older.path]);
  });

  it("does not restore across a different scan root or a changed, missing, or blocked candidate", async () => {
    const freshChoice = async () => {
      const session = new ZToolsImportSelectionSession();
      const first = controller(session);
      await first.scanPath("/sources"); first.toggle(older.path, true); first.dispose();
      return session;
    };
    const rootSession = await freshChoice();
    const differentRoot = controller(rootSession);
    await differentRoot.scanPath("/other-root");
    expect(differentRoot.snapshot.selected).toEqual(new Set());
    differentRoot.dispose();

    const changedSession = await freshChoice();
    const changed = controller(changedSession, [blocked, { ...older, version: "1.1.0" }, newer]);
    await changed.scanPath("/sources");
    expect(changed.snapshot.selected).toEqual(new Set());

    const replacedSession = await freshChoice();
    const replaced = controller(replacedSession, [blocked, { ...older, package_path: "/sources/replaced-package" }, newer]);
    await replaced.scanPath("/sources");
    expect(replaced.snapshot.selected).toEqual(new Set());

    const identitySession = await freshChoice();
    const changedIdentity = controller(identitySession, [blocked, { ...older, installation_id: "changed-id" }, newer]);
    await changedIdentity.scanPath("/sources");
    expect(changedIdentity.snapshot.selected).toEqual(new Set());

    const missingSession = await freshChoice();
    const missing = controller(missingSession, [blocked, newer]);
    await missing.scanPath("/sources");
    expect(missing.snapshot.selected).toEqual(new Set());

    const blockedSession = await freshChoice();
    const newlyBlocked = controller(blockedSession, [blocked, { ...older, errors: ["blocked by scan"] }, newer]);
    await newlyBlocked.scanPath("/sources");
    expect(newlyBlocked.snapshot.selected).toEqual(new Set());
  });

  it("remembers the previous root during successful A-to-B-to-A switches in one controller", async () => {
    const session = new ZToolsImportSelectionSession();
    const rootA = "/root-A";
    const rootB = "/root-B";
    const foundByRoot = new Map([[rootA, candidates], [rootB, [blocked, older, newer]]]);
    const svc = services(candidates);
    svc.scanPath = vi.fn(async path => foundByRoot.get(path) ?? []);
    const instance = new ZToolsImportController(svc, () => {}, session);

    await instance.scanPath(rootA);
    instance.toggle(older.path, true);
    await instance.scanPath(rootB);
    expect(instance.snapshot.selected).toEqual(new Set());
    instance.toggle(newer.path, true);
    await instance.scanPath(rootA);
    expect(instance.snapshot.selected).toEqual(new Set([older.path]));
    expect(svc.scanPath).toHaveBeenCalledTimes(3);
  });

  it("protects the oldest target snapshot when switching roots at the four-root limit", async () => {
    const session = new ZToolsImportSelectionSession();
    const roots = ["/root-A", "/root-B", "/root-C", "/root-D", "/root-E"] as const;
    const svc = services(candidates);
    svc.scanPath = vi.fn(async () => candidates);
    const instance = new ZToolsImportController(svc, () => {}, session);
    const choices = [older.path, newer.path, older.path, newer.path, older.path];
    for (let index = 0; index < roots.length; index += 1) {
      await instance.scanPath(roots[index]);
      instance.toggle(choices[index], true);
    }
    expect(session.size).toBe(4);

    await instance.scanPath(roots[0]);
    expect(instance.snapshot.selected).toEqual(new Set([older.path]));
    expect(session.size).toBe(4);

    await instance.scanPath(roots[1]);
    expect(instance.snapshot.selected).toEqual(new Set());
  });

  it("saves the current same-root choice over its older snapshot before refresh", async () => {
    const session = new ZToolsImportSelectionSession();
    const instance = controller(session);
    await instance.scanPath("/same-root");
    instance.toggle(older.path, true);
    await instance.scanPath("/other-root");
    await instance.scanPath("/same-root");
    expect(instance.snapshot.selected).toEqual(new Set([older.path]));

    instance.toggle(older.path, false);
    instance.toggle(newer.path, true);
    await instance.scanPath("/same-root");
    expect(instance.snapshot.selected).toEqual(new Set([newer.path]));
  });

  it("suppresses a remembered conflict choice when its old group becomes one selectable candidate", async () => {
    const session = new ZToolsImportSelectionSession();
    const first = controller(session);
    await first.scanPath("/sources");
    first.toggle(older.path, true);
    first.dispose();

    const nowSingle = controller(session, [older]);
    await nowSingle.scanPath("/sources");
    expect(nowSingle.snapshot.selected).toEqual(new Set());
  });

  it("does not save a failed or stale root scan over the active selection", async () => {
    const session = new ZToolsImportSelectionSession();
    const failing = services(candidates);
    failing.scanPath = vi.fn(async path => {
      if (path === "/root-B") throw new Error("deliberate scan failure");
      return candidates;
    });
    const active = new ZToolsImportController(failing, () => {}, session);
    await active.scanPath("/root-A");
    active.toggle(older.path, true);
    await active.scanPath("/root-B");
    expect(active.snapshot.selected).toEqual(new Set([older.path]));
    await active.scanPath("/root-A");
    expect(active.snapshot.selected).toEqual(new Set([older.path]));
    expect(session.has({ kind: "path", path: "/root-B" })).toBe(false);

    let resolveLate!: (value: ZToolsImportCandidate[]) => void;
    const lateServices = services(candidates);
    lateServices.scanPath = vi.fn((path): Promise<ZToolsImportCandidate[]> => path === "/root-B"
      ? new Promise(resolve => { resolveLate = resolve; })
      : Promise.resolve(candidates));
    const oldController = new ZToolsImportController(lateServices, () => {}, session);
    await oldController.scanPath("/root-A");
    oldController.toggle(older.path, true);
    const staleB = oldController.scanPath("/root-B");
    oldController.dispose();

    const reopened = new ZToolsImportController(lateServices, () => {}, session);
    await reopened.scanPath("/root-A");
    expect(reopened.snapshot.selected).toEqual(new Set([older.path]));
    resolveLate([blocked, newer]);
    await staleB;
    expect(reopened.snapshot.selected).toEqual(new Set([older.path]));
    expect(session.has({ kind: "path", path: "/root-B" })).toBe(false);
  });

  it("drops a remembered choice when its exact plugin is already installed", async () => {
    const session = new ZToolsImportSelectionSession();
    const first = controller(session);
    await first.scanPath("/sources"); first.toggle(older.path, true); first.dispose();
    const installed: InstalledPlugin = {
      id: "calculator", name: "calculator", version: "0.9.0", path: "/installed/calculator", enabled: false,
      manifest: {}, created_at: "", updated_at: "",
    };
    const next = controller(session, candidates, [installed]);
    await next.scanPath("/sources");
    expect(next.snapshot.selected).toEqual(new Set());
    expect(session.size).toBe(0);
  });

  it("ignores a scan that resolves after its controller is disposed", async () => {
    const session = new ZToolsImportSelectionSession();
    let resolveOld!: (value: ZToolsImportCandidate[]) => void;
    const staleServices = services(candidates);
    staleServices.scanPath = () => new Promise(resolve => { resolveOld = resolve; });
    const stale = new ZToolsImportController(staleServices, () => {}, session);
    const pending = stale.scanPath("/sources");
    stale.dispose();

    const current = controller(session);
    await current.scanPath("/sources"); current.toggle(newer.path, true); current.dispose();
    resolveOld([blocked, older, newer]);
    await pending;

    const reopened = controller(session);
    await reopened.scanPath("/sources");
    expect(reopened.snapshot.selected).toEqual(new Set([newer.path]));
  });

  it("keeps the snapshot budget in UTF-16 units for non-ASCII metadata", () => {
    const session = new ZToolsImportSelectionSession();
    const longName = "图".repeat(4000);
    const pair = [
      candidate("/non-ascii/a.zip", { installation_id: "non-ascii", name: longName }),
      candidate("/non-ascii/b.zip", { installation_id: "non-ascii", name: longName }),
    ];
    session.remember({ kind: "path", path: "/non-ascii" }, pair, new Set([pair[1].path]));
    expect(session.has({ kind: "path", path: "/non-ascii" })).toBe(true);
    expect(session.restore({ kind: "path", path: "/non-ascii" }, pair, [])).toEqual(new Set([pair[1].path]));
  });

  it("drops a snapshot before retaining an oversized aggregate of bounded non-ASCII groups", () => {
    const session = new ZToolsImportSelectionSession();
    const found: ZToolsImportCandidate[] = [];
    const selected = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const id = `large-${index}`;
      const first = candidate(`/large/${index}/a.zip`, { installation_id: id, name: "图".repeat(4000) });
      const second = candidate(`/large/${index}/b.zip`, { installation_id: id, name: "图".repeat(4000) });
      found.push(first, second);
      selected.add(first.path);
    }
    const root = { kind: "path" as const, path: "/large" };
    session.remember(root, found, selected);
    expect(session.has(root)).toBe(false);
    expect(session.restore(root, found, [])).toEqual(new Set());
  });

  it("keeps the first 64 identity-sorted choices when the per-root choice cap is exceeded", () => {
    const session = new ZToolsImportSelectionSession();
    const found: ZToolsImportCandidate[] = [];
    const selected = new Set<string>();
    for (let index = 0; index < 65; index += 1) {
      const id = `cap-${String(index).padStart(2, "0")}`;
      const first = candidate(`/cap/${index}/a.zip`, { installation_id: id });
      const second = candidate(`/cap/${index}/b.zip`, { installation_id: id });
      found.push(first, second);
      selected.add(first.path);
    }
    const root = { kind: "path" as const, path: "/cap" };
    session.remember(root, found, selected);
    expect(session.restore(root, found, []).size).toBe(64);
    expect(session.restore(root, found, []).has("/cap/63/a.zip")).toBe(true);
    expect(session.restore(root, found, []).has("/cap/64/a.zip")).toBe(false);
  });

  it("evicts oldest roots deterministically at the four-root memory limit", async () => {
    const session = new ZToolsImportSelectionSession();
    for (let index = 0; index < 5; index += 1) {
      const root = `/root-${index}`;
      const instance = controller(session);
      await instance.scanPath(root); instance.toggle(index % 2 ? newer.path : older.path, true); instance.dispose();
    }
    expect(session.size).toBe(4);
    const evicted = controller(session);
    await evicted.scanPath("/root-0");
    expect(evicted.snapshot.selected).toEqual(new Set());
    const retained = controller(session);
    await retained.scanPath("/root-4");
    expect(retained.snapshot.selected).toEqual(new Set([older.path]));
  });
});
