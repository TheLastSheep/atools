import { describe, expect, it, vi } from "vitest";
import { PluginInventoryController, type PluginInventoryServices } from "../../src/lib/pluginInventoryController";
import { firstOpenablePluginFeature } from "../../src/lib/pluginOpen";
import type { InstalledPlugin } from "../../src/lib/types";

function plugin(id = "fixture.imported", overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id, name: id, version: "1.0.0", path: `/plugins/${id}`, enabled: false, source_kind: "imported",
    manifest: { title: "测试插件", description: "fixture", permissions: ["clipboard.read", "fs.read"] },
    created_at: "2026-01-01", updated_at: "2026-01-01", ...overrides,
  };
}

function services(overrides: Partial<PluginInventoryServices> = {}): PluginInventoryServices {
  return {
    available: () => true,
    listPlugins: vi.fn(async () => []),
    chooseDirectory: vi.fn(async () => "/chosen/plugin"),
    installDirectory: vi.fn(async () => plugin("fixture.installed", { enabled: true })),
    updateDirectory: vi.fn(async (id: string) => plugin(id, { enabled: true })),
    togglePlugin: vi.fn(async () => {}),
    authorizePlugin: vi.fn(async (id: string) => plugin(id, { enabled: true })),
    uninstallPlugin: vi.fn(async () => {}),
    revealPath: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("PluginInventoryController", () => {
  it("holds the global lock before the directory picker and prevents overlapping mutations", async () => {
    const picker = deferred<string | null>();
    const api = services({ chooseDirectory: vi.fn(() => picker.promise) });
    const controller = new PluginInventoryController(api, () => {}, [plugin()]);
    const installing = controller.install();
    expect(controller.snapshot.busy).toBe("choosing");
    await controller.toggle("fixture.imported", true);
    expect(api.togglePlugin).not.toHaveBeenCalled();
    expect(api.installDirectory).not.toHaveBeenCalled();
    picker.resolve(null);
    await installing;
    expect(controller.snapshot.busy).toBe("idle");
    expect(controller.snapshot.message).toBe("已取消安装插件");
  });

  it("keeps a committed install separate from a failed catalogue read and retries only the read", async () => {
    const api = services({
      listPlugins: vi.fn().mockRejectedValueOnce(new Error("db busy")).mockResolvedValueOnce([plugin("fixture.installed", { enabled: true })]),
    });
    const controller = new PluginInventoryController(api, () => {}, []);
    await controller.install();
    expect(api.installDirectory).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "install", pluginId: "fixture.installed" });
    expect(controller.snapshot.refreshError).toBe("db busy");
    expect(controller.snapshot.plugins).toHaveLength(1);
    expect(controller.snapshot.plugins[0].id).toBe("fixture.installed");
    await controller.toggle("fixture.installed", false);
    expect(api.togglePlugin).not.toHaveBeenCalled();
    await controller.retryList();
    expect(api.listPlugins).toHaveBeenCalledTimes(2);
    expect(api.installDirectory).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.plugins[0].enabled).toBe(true);
    expect(controller.snapshot.refreshError).toBe("");
    await controller.toggle("fixture.installed", false);
    expect(api.togglePlugin).toHaveBeenCalledTimes(1);
  });

  it("increments a commit revision for each write but not for refresh, retry, or reveal", async () => {
    const initial = plugin("repeat.update");
    const api = services({
      listPlugins: vi.fn(async () => [plugin(initial.id, { enabled: false })]),
      updateDirectory: vi.fn(async () => plugin(initial.id, { enabled: false, version: "2.0.0" })),
    });
    const controller = new PluginInventoryController(api, () => {}, [initial]);
    expect(controller.snapshot.commitRevision).toBe(0);
    await controller.refresh();
    await controller.reveal(initial.id);
    expect(controller.snapshot.commitRevision).toBe(0);
    await controller.update(initial.id);
    expect(controller.snapshot.commitRevision).toBe(1);
    await controller.refresh();
    expect(controller.snapshot.commitRevision).toBe(1);
    await controller.update(initial.id);
    expect(controller.snapshot.commitRevision).toBe(2);
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "update", pluginId: initial.id });
  });

  it("treats a null install response as committed and retries only the catalogue read", async () => {
    const api = services({
      installDirectory: vi.fn(async () => null as unknown as InstalledPlugin),
      listPlugins: vi.fn().mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValueOnce([plugin("real.installed")]),
    });
    const controller = new PluginInventoryController(api, () => {}, []);
    await controller.install();
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "install", pluginId: "", title: "插件" });
    expect(controller.snapshot.lastChangedId).toBeNull();
    expect(controller.snapshot.refreshError).toBe("read unavailable");
    await controller.install();
    expect(api.installDirectory).toHaveBeenCalledTimes(1);
    await controller.retryList();
    expect(api.listPlugins).toHaveBeenCalledTimes(2);
    expect(api.installDirectory).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.plugins.map(item => item.id)).toEqual(["real.installed"]);
  });

  it("keeps the requested owner and retries only the list when update returns another plugin", async () => {
    const owner = plugin("requested.owner");
    const api = services({
      updateDirectory: vi.fn(async () => plugin("wrong.owner", { enabled: true })),
      listPlugins: vi.fn().mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValueOnce([owner]),
    });
    const controller = new PluginInventoryController(api, () => {}, [owner]);
    await controller.update(owner.id);
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "update", pluginId: owner.id, title: "测试插件" });
    expect(controller.snapshot.plugins).toEqual([owner]);
    expect(controller.snapshot.refreshError).toBe("read unavailable");
    await controller.update(owner.id);
    expect(api.updateDirectory).toHaveBeenCalledTimes(1);
    await controller.retryList();
    expect(api.listPlugins).toHaveBeenCalledTimes(2);
    expect(api.updateDirectory).toHaveBeenCalledTimes(1);
  });

  it("does not accept a malformed authorization response even when its ID matches", async () => {
    const owner = plugin("requested.owner");
    const api = services({
      authorizePlugin: vi.fn(async () => ({ id: owner.id, enabled: true } as unknown as InstalledPlugin)),
      listPlugins: vi.fn(async () => [plugin(owner.id, { enabled: true })]),
    });
    const controller = new PluginInventoryController(api, () => {}, [owner]);
    await controller.authorize(owner.id);
    expect(controller.snapshot.plugins).toHaveLength(1);
    expect(controller.snapshot.plugins[0].id).toBe(owner.id);
    expect(controller.snapshot.plugins[0].enabled).toBe(true);
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "authorize", pluginId: owner.id });
    expect(controller.snapshot.message).toContain("返回记录无效或所有者不匹配");
  });

  it("does not optimistically change enabled state before native commit and readback", async () => {
    const toggle = deferred<void>();
    const api = services({
      togglePlugin: vi.fn(() => toggle.promise),
      listPlugins: vi.fn(async () => [plugin("fixture.imported", { enabled: false })]),
    });
    const controller = new PluginInventoryController(api, () => {}, [plugin("fixture.imported", { enabled: true })]);
    const operation = controller.toggle("fixture.imported", false);
    expect(controller.snapshot.plugins[0].enabled).toBe(true);
    expect(controller.snapshot.busy).toBe("mutating");
    toggle.resolve();
    await operation;
    expect(controller.snapshot.plugins[0].enabled).toBe(false);
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "toggle", enabled: false });
  });

  it("confirms disabled-plugin permissions and uses the authorization command rather than toggle", async () => {
    const api = services();
    const controller = new PluginInventoryController(api, () => {}, [plugin()]);
    await controller.authorize("fixture.imported");
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "授权启用插件", confirmLabel: "授权启用", tone: "danger",
      message: expect.stringContaining("permissions: clipboard.read / fs.read"),
    }));
    expect(api.authorizePlugin).toHaveBeenCalledWith("fixture.imported");
    expect(api.togglePlugin).not.toHaveBeenCalled();
    expect(controller.snapshot.committedAction?.kind).toBe("authorize");
  });

  it("does not authorize when the user cancels the permission confirmation", async () => {
    const api = services({ confirm: vi.fn(async () => false) });
    const controller = new PluginInventoryController(api, () => {}, [plugin()]);
    await controller.authorize("fixture.imported");
    expect(api.authorizePlugin).not.toHaveBeenCalled();
    expect(api.togglePlugin).not.toHaveBeenCalled();
    expect(controller.snapshot.plugins[0].enabled).toBe(false);
    expect(controller.snapshot.message).toContain("已取消");
  });

  it("re-enables a disabled built-in with toggle, while imported plugins require authorization", async () => {
    const builtin = plugin("builtin.fixture", { source_kind: "builtin", path: "/Applications/ATools.app/Contents/Resources/plugins/builtin/fixture" });
    const imported = plugin("imported.fixture");
    const api = services({ listPlugins: vi.fn(async () => [plugin(builtin.id, { ...builtin, enabled: true }), imported]) });
    const controller = new PluginInventoryController(api, () => {}, [builtin, imported]);
    await controller.toggle(builtin.id, true);
    expect(api.togglePlugin).toHaveBeenCalledWith(builtin.id, true);
    expect(controller.snapshot.committedAction).toMatchObject({ kind: "toggle", pluginId: builtin.id, enabled: true });
    await controller.toggle("imported.fixture", true);
    expect(api.togglePlugin).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.error).toContain("需要先核对 manifest 权限");
    await controller.authorize("builtin.fixture");
    expect(api.authorizePlugin).not.toHaveBeenCalled();
  });

  it("blocks built-in update and uninstall from the actual installed record", async () => {
    const builtin = plugin("builtin.fixture", { source_kind: "builtin", path: "/Applications/ATools.app/Contents/Resources/plugins/builtin/fixture" });
    const api = services();
    const controller = new PluginInventoryController(api, () => {}, [builtin]);
    await controller.update(builtin.id);
    await controller.uninstall(builtin.id);
    expect(controller.snapshot.error).toContain("内置插件不可卸载");
    expect(api.chooseDirectory).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.updateDirectory).not.toHaveBeenCalled();
    expect(api.uninstallPlugin).not.toHaveBeenCalled();
  });

  it("uses source metadata rather than path text to authorize source-sensitive writes", async () => {
    const importedBuiltinNamed = plugin("builtin-helper", { path: "/plugins/builtin-helper" });
    const legacyBuiltinPath = plugin("legacy", { path: "/resources/plugins/builtin/legacy" });
    delete legacyBuiltinPath.source_kind;
    const external = plugin("external", { source_kind: "external", path: "/outside/plugins/external" });
    const api = services();
    const controller = new PluginInventoryController(api, () => {}, [importedBuiltinNamed, legacyBuiltinPath, external]);

    await controller.toggle(importedBuiltinNamed.id, true);
    await controller.toggle(legacyBuiltinPath.id, true);
    await controller.toggle(external.id, true);
    expect(api.togglePlugin).not.toHaveBeenCalled();
    expect(controller.snapshot.error).toContain("来源未验证为内置");

    await controller.update(legacyBuiltinPath.id);
    await controller.uninstall(external.id);
    expect(api.chooseDirectory).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.updateDirectory).not.toHaveBeenCalled();
    expect(api.uninstallPlugin).not.toHaveBeenCalled();

    await controller.authorize(importedBuiltinNamed.id);
    expect(api.authorizePlugin).toHaveBeenCalledWith(importedBuiltinNamed.id);
  });

  it("preserves only previously verified source metadata across write responses", async () => {
    const owner = plugin("requested.owner", { path: "/plugins/builtin-helper", source_kind: "imported" });
    const api = services({
      updateDirectory: vi.fn(async () => plugin(owner.id, { enabled: true, source_kind: "builtin" })),
      listPlugins: vi.fn().mockRejectedValueOnce(new Error("read unavailable")),
    });
    const controller = new PluginInventoryController(api, () => {}, [owner]);
    await controller.update(owner.id);
    expect(controller.snapshot.plugins[0].source_kind).toBe("imported");
    expect(controller.snapshot.refreshError).toBe("read unavailable");
  });

  it("confirms that uninstall removes plugin data before issuing the native write", async () => {
    const api = services({ confirm: vi.fn(async () => false) });
    const controller = new PluginInventoryController(api, () => {}, [plugin()]);
    await controller.uninstall("fixture.imported");
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "卸载插件", message: expect.stringContaining("插件数据"), confirmLabel: "卸载",
    }));
    expect(api.uninstallPlugin).not.toHaveBeenCalled();
    expect(controller.snapshot.plugins).toHaveLength(1);
  });

  it("preserves the prior catalogue when a normal refresh fails", async () => {
    const api = services({ listPlugins: vi.fn(async () => { throw new Error("offline"); }) });
    const original = plugin();
    const controller = new PluginInventoryController(api, () => {}, [original]);
    await controller.refresh();
    expect(controller.snapshot.plugins).toEqual([original]);
    expect(controller.snapshot.refreshError).toBe("offline");
  });

  it("rejects malformed list rows without replacing the last good catalogue", async () => {
    const original = plugin();
    const api = services({ listPlugins: vi.fn(async () => [plugin("valid.next"), { id: "incomplete" } as InstalledPlugin]) });
    const controller = new PluginInventoryController(api, () => {}, [original]);
    await controller.refresh();
    expect(controller.snapshot.plugins).toEqual([original]);
    expect(controller.snapshot.refreshError).toContain("清单格式无效");
  });

  it("accepts omitted optional feature explanations and normalizes them for rendering", async () => {
    const row = plugin("fixture.optional-explain", { manifest: { features: [{ code: "open" }] } as InstalledPlugin["manifest"] });
    const api = services({ listPlugins: vi.fn(async () => [row]) });
    const controller = new PluginInventoryController(api, () => {});
    await controller.refresh();
    expect(controller.snapshot.refreshError).toBe("");
    expect(controller.snapshot.plugins[0].manifest.features?.[0].explain).toBe("");
  });

  it("keeps blank feature codes readable without treating them as openable", async () => {
    const row = plugin("fixture.blank-code", {
      manifest: { features: [{ code: "" }, { code: "  " }] } as InstalledPlugin["manifest"],
    });
    const api = services({ listPlugins: vi.fn(async () => [row]) });
    const controller = new PluginInventoryController(api, () => {});
    await controller.refresh();
    expect(controller.snapshot.refreshError).toBe("");
    expect(controller.snapshot.plugins).toHaveLength(1);
    expect(firstOpenablePluginFeature(controller.snapshot.plugins[0])).toBeNull();
  });

  it("sanitizes malformed initial records so operations cannot dereference them", async () => {
    const api = services();
    const controller = new PluginInventoryController(api, () => {}, [null, plugin()] as unknown as InstalledPlugin[]);
    expect(controller.snapshot.plugins.map(item => item.id)).toEqual(["fixture.imported"]);
    expect(controller.snapshot.refreshError).toContain("1 条记录无效");
    await controller.toggle("missing", true);
    expect(api.togglePlugin).not.toHaveBeenCalled();
    expect(controller.snapshot.error).toContain("不在当前清单");
  });

  it("allows a read-only reveal while committed state awaits a successful readback", async () => {
    const api = services({ listPlugins: vi.fn().mockRejectedValueOnce(new Error("read failed")) });
    const controller = new PluginInventoryController(api, () => {}, [plugin()]);
    await controller.toggle("fixture.imported", false);
    await controller.reveal("fixture.imported");
    expect(api.revealPath).toHaveBeenCalledWith("/plugins/fixture.imported");
    expect(api.togglePlugin).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.refreshError).toBe("read failed");
    expect(controller.snapshot.message).toContain("已完成，但清单刷新失败");
  });

  it("ignores late picker results after disposal", async () => {
    const picker = deferred<string | null>();
    const changes: unknown[] = [];
    const api = services({ chooseDirectory: vi.fn(() => picker.promise) });
    const controller = new PluginInventoryController(api, state => changes.push(state), []);
    const operation = controller.install();
    const callbackCount = changes.length;
    controller.dispose();
    picker.resolve("/chosen/plugin");
    await operation;
    expect(api.installDirectory).not.toHaveBeenCalled();
    expect(changes).toHaveLength(callbackCount);
  });
  it("announces a successful catalogue read through its semantic feedback kind", async () => {
    const api = services({ listPlugins: vi.fn(async () => [plugin()]) });
    const controller = new PluginInventoryController(api, () => {});
    await controller.refresh();
    expect(controller.snapshot).toMatchObject({ busy: "idle", messageKind: "read-success", message: "已读取 1 个插件" });
  });

  it("locks writes after an ordinary read failure and unlocks only after a successful retry", async () => {
    const original = plugin();
    const api = services({ listPlugins: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([original]) });
    const controller = new PluginInventoryController(api, () => {}, [original]);
    await controller.refresh();
    expect(controller.snapshot.messageKind).toBe("read-failure");
    await controller.install();
    await controller.authorize(original.id);
    await controller.uninstall(original.id);
    expect(api.chooseDirectory).not.toHaveBeenCalled();
    expect(api.authorizePlugin).not.toHaveBeenCalled();
    expect(api.uninstallPlugin).not.toHaveBeenCalled();
    await controller.reveal(original.id);
    expect(api.revealPath).toHaveBeenCalledWith(original.path);
    expect(controller.snapshot.refreshError).toBe("offline");
    await controller.retryList();
    expect(controller.snapshot.refreshError).toBe("");
    await controller.authorize(original.id);
    expect(api.authorizePlugin).toHaveBeenCalledOnce();
  });

});
