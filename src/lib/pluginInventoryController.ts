import type { InstalledPlugin } from "./types";
import type { PluginInventoryMessageKind } from "./pluginInventoryFeedback";
import { pluginInventory } from "./pluginInventory";
import { normalizeInstalledPlugin, parseInstalledPluginList, sanitizeInitialPluginList } from "./installedPluginBoundary";

export type PluginInventoryBusy = "idle" | "loading" | "choosing" | "confirming" | "mutating" | "refreshing" | "revealing";
export type PluginInventoryCommittedAction = {
  kind: "install" | "update" | "toggle" | "authorize" | "uninstall";
  pluginId: string;
  title: string;
  enabled?: boolean;
};
export type PluginInventoryControllerState = {
  plugins: InstalledPlugin[];
  busy: PluginInventoryBusy;
  busyPluginId: string | null;
  message: string;
  messageKind: PluginInventoryMessageKind;
  error: string;
  refreshError: string;
  lastChangedId: string | null;
  commitRevision: number;
  committedAction: PluginInventoryCommittedAction | null;
};
export type PluginInventoryConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "default" | "danger";
};
export type PluginInventoryServices = {
  available(): boolean;
  listPlugins(): Promise<InstalledPlugin[]>;
  chooseDirectory(title: string): Promise<string | null>;
  installDirectory(path: string): Promise<InstalledPlugin>;
  updateDirectory(pluginId: string, path: string): Promise<InstalledPlugin>;
  togglePlugin(pluginId: string, enabled: boolean): Promise<void>;
  authorizePlugin(pluginId: string): Promise<InstalledPlugin>;
  uninstallPlugin(pluginId: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  confirm(request: PluginInventoryConfirmRequest): Promise<boolean>;
};

const importedRequired = "插件来源尚未验证为可管理的导入插件，请刷新插件清单";

/** Owns the installed-plugin catalogue and serializes all native settings actions. */
export class PluginInventoryController {
  private state: PluginInventoryControllerState;
  private busyLock = false;
  private readbackPending = false;
  private catalogueReadFailed = false;
  private revision = 0;
  private alive = true;

  constructor(
    private readonly services: PluginInventoryServices,
    private readonly onChange: (state: PluginInventoryControllerState) => void,
    initialPlugins: InstalledPlugin[] = [],
  ) {
    const sanitized = sanitizeInitialPluginList(initialPlugins);
    this.state = {
      plugins: sanitized.plugins, busy: "idle", busyPluginId: null,
      message: sanitized.invalidCount ? "初始插件清单包含无效记录，请重试读取清单" : "",
      messageKind: sanitized.invalidCount ? "warning" : "none", error: "",
      refreshError: sanitized.invalidCount ? `初始插件清单有 ${sanitized.invalidCount} 条记录无效` : "",
      lastChangedId: null, commitRevision: 0, committedAction: null,
    };
    this.publish();
  }

  get snapshot(): PluginInventoryControllerState {
    return { ...this.state, plugins: [...this.state.plugins], committedAction: this.state.committedAction ? { ...this.state.committedAction } : null };
  }

  dispose() {
    this.alive = false;
    this.revision += 1;
  }

  async refresh() { await this.readPlugins("loading"); }
  async retryList() { await this.readPlugins("loading"); }

  async install() {
    if (!this.acquire()) return;
    const token = this.revision;
    this.patch({ busy: "choosing", busyPluginId: null, error: "", refreshError: "", messageKind: "progress", message: "请选择包含 plugin.json 的插件目录" });
    try {
      if (!this.services.available()) throw new Error("桌面运行时未连接，无法安装插件");
      const path = await this.services.chooseDirectory("选择包含 plugin.json 的插件目录");
      if (!this.isCurrent(token)) return;
      if (path === null) {
        this.patch({ messageKind: "cancelled", message: "已取消安装插件" });
        return;
      }
      this.patch({ busy: "mutating", messageKind: "progress", message: "正在安装插件" });
      const result: unknown = await this.services.installDirectory(path);
      if (!this.isCurrent(token)) return;
      const plugin = normalizeInstalledPlugin(result);
      await this.commitAndRefresh(token, {
        kind: "install", pluginId: plugin?.id ?? "", title: plugin ? pluginTitle(plugin) : "插件",
        ...(plugin ? { enabled: plugin.enabled } : {}),
      }, plugin ? withoutSourceKind(plugin) : undefined, plugin ? undefined : "安装接口返回记录无效，已通过清单重新确认");
    } catch (error) {
      if (this.isCurrent(token)) this.fail(error, "安装插件失败");
    } finally {
      this.release(token);
    }
  }

  async update(pluginId: string) {
    if (!this.acquire()) return;
    const token = this.revision;
    const plugin = this.findPlugin(pluginId);
    try {
      if (!plugin) throw new Error("插件已不在当前清单中，请先刷新插件清单");
      const updateAction = pluginAction(plugin, "更新插件");
      if (!updateAction.available) throw new Error(updateAction.reason || importedRequired);
      if (!this.services.available()) throw new Error("桌面运行时未连接，无法更新插件");
      this.patch({ busy: "choosing", busyPluginId: pluginId, error: "", refreshError: "", messageKind: "progress", message: `正在选择 ${pluginTitle(plugin)} 的更新目录` });
      const path = await this.services.chooseDirectory(`选择 ${pluginTitle(plugin)} 的更新目录`);
      if (!this.isCurrent(token)) return;
      if (path === null) {
        this.patch({ messageKind: "cancelled", message: `已取消更新 ${pluginTitle(plugin)}` });
        return;
      }
      this.patch({ busy: "mutating", messageKind: "progress", message: "正在更新插件" });
      const result: unknown = await this.services.updateDirectory(pluginId, path);
      if (!this.isCurrent(token)) return;
      const normalized = normalizeInstalledPlugin(result);
      const updated = normalized?.id === pluginId ? withVerifiedSourceKind(normalized, plugin.source_kind) : null;
      await this.commitAndRefresh(token, {
        kind: "update", pluginId, title: pluginTitle(plugin), ...(updated ? { enabled: updated.enabled } : {}),
      }, updated ?? undefined, updated ? undefined : "更新接口返回记录无效或所有者不匹配，已通过清单重新确认");
    } catch (error) {
      if (this.isCurrent(token)) this.fail(error, "更新插件失败");
    } finally {
      this.release(token);
    }
  }

  async toggle(pluginId: string, enabled: boolean) {
    if (!this.acquire()) return;
    const token = this.revision;
    const plugin = this.findPlugin(pluginId);
    try {
      if (!plugin) throw new Error("插件已不在当前清单中，请先刷新插件清单");
      if (enabled && plugin.source_kind !== "builtin") {
        throw new Error(plugin.source_kind === "imported"
          ? "导入插件需要先核对 manifest 权限并使用“授权启用”"
          : "插件来源未验证为内置插件，请核对权限并使用“授权启用”");
      }
      if (!this.services.available()) throw new Error("桌面运行时未连接，无法切换插件状态");
      this.patch({ busy: "mutating", busyPluginId: pluginId, error: "", refreshError: "", messageKind: "progress", message: `正在${enabled ? "启用" : "停用"}插件` });
      await this.services.togglePlugin(pluginId, enabled);
      if (!this.isCurrent(token)) return;
      await this.commitAndRefresh(token, { kind: "toggle", pluginId, title: pluginTitle(plugin), enabled });
    } catch (error) {
      if (this.isCurrent(token)) this.fail(error, "切换插件状态失败");
    } finally {
      this.release(token);
    }
  }

  async authorize(pluginId: string) {
    if (!this.acquire()) return;
    const token = this.revision;
    const plugin = this.findPlugin(pluginId);
    try {
      if (!plugin) throw new Error("插件已不在当前清单中，请先刷新插件清单");
      if (plugin.enabled) throw new Error("该插件已经启用，无需重复授权");
      if (plugin.source_kind === "builtin") throw new Error("内置插件无需授权，可直接启用");
      if (!this.services.available()) throw new Error("桌面运行时未连接，无法授权启用插件");
      this.patch({ busy: "confirming", busyPluginId: pluginId, error: "", refreshError: "", messageKind: "progress", message: "请核对插件声明的权限" });
      const permissions = manifestNames(plugin.manifest.permissions);
      const tools = manifestKeys(plugin.manifest.tools);
      const summary = [
        permissions.length ? `permissions: ${permissions.join(" / ")}` : "permissions: 未声明",
        tools.length ? `Agent tools: ${tools.join(" / ")}` : "Agent tools: 未声明",
      ].join("；");
      const confirmed = await this.services.confirm({
        title: "授权启用插件",
        message: `${pluginTitle(plugin)} 将启用并进入主搜索。请核对 manifest 权限：${summary}。启用后插件声明的 Agent tools 会同步到 Agent/MCP 白名单，但仍需单独启用。确认继续？`,
        confirmLabel: "授权启用",
        tone: "danger",
      });
      if (!this.isCurrent(token)) return;
      if (!confirmed) {
        this.patch({ messageKind: "cancelled", message: `已取消授权启用 ${pluginTitle(plugin)}` });
        return;
      }
      this.patch({ busy: "mutating", messageKind: "progress", message: "正在授权启用插件" });
      const result: unknown = await this.services.authorizePlugin(pluginId);
      if (!this.isCurrent(token)) return;
      const normalized = normalizeInstalledPlugin(result);
      const authorized = normalized?.id === pluginId ? withVerifiedSourceKind(normalized, plugin.source_kind) : null;
      await this.commitAndRefresh(token, {
        kind: "authorize", pluginId, title: pluginTitle(plugin), ...(authorized ? { enabled: authorized.enabled } : {}),
      }, authorized ?? undefined, authorized ? undefined : "授权接口返回记录无效或所有者不匹配，已通过清单重新确认");
    } catch (error) {
      if (this.isCurrent(token)) this.fail(error, "授权启用插件失败");
    } finally {
      this.release(token);
    }
  }

  async uninstall(pluginId: string) {
    if (!this.acquire()) return;
    const token = this.revision;
    const plugin = this.findPlugin(pluginId);
    try {
      if (!plugin) throw new Error("插件已不在当前清单中，请先刷新插件清单");
      const uninstallAction = pluginAction(plugin, "卸载插件");
      if (!uninstallAction.available) throw new Error(uninstallAction.reason || importedRequired);
      if (!this.services.available()) throw new Error("桌面运行时未连接，无法卸载插件");
      this.patch({ busy: "confirming", busyPluginId: pluginId, error: "", refreshError: "", messageKind: "progress", message: "请确认卸载范围" });
      const confirmed = await this.services.confirm({
        title: "卸载插件",
        message: `确定卸载 ${pluginTitle(plugin)}？此操作会移除插件本体、指令索引和插件数据。`,
        confirmLabel: "卸载",
        tone: "danger",
      });
      if (!this.isCurrent(token)) return;
      if (!confirmed) {
        this.patch({ messageKind: "cancelled", message: "已取消卸载插件" });
        return;
      }
      this.patch({ busy: "mutating", messageKind: "progress", message: "正在卸载插件" });
      await this.services.uninstallPlugin(pluginId);
      if (!this.isCurrent(token)) return;
      await this.commitAndRefresh(token, { kind: "uninstall", pluginId, title: pluginTitle(plugin) });
    } catch (error) {
      if (this.isCurrent(token)) this.fail(error, "卸载插件失败");
    } finally {
      this.release(token);
    }
  }

  async reveal(pluginId: string) {
    if (!this.acquire(true)) return;
    const token = this.revision;
    const plugin = this.findPlugin(pluginId);
    try {
      if (!plugin) throw new Error("插件已不在当前清单中，请先刷新插件清单");
      if (!this.services.available()) throw new Error(`桌面运行时未连接，无法定位：${plugin.path}`);
      this.patch({ busy: "revealing", busyPluginId: pluginId, error: "", ...(this.readbackPending ? {} : { messageKind: "progress", message: "正在定位插件目录" }) });
      await this.services.revealPath(plugin.path);
      if (this.isCurrent(token) && !this.readbackPending) this.patch({ messageKind: "action-success", message: `已定位 ${pluginTitle(plugin)}` });
    } catch (error) {
      if (this.isCurrent(token)) {
        if (this.readbackPending) this.patch({ error: `定位插件目录失败：${errorMessage(error)}` });
        else this.fail(error, "定位插件目录失败");
      }
    } finally {
      this.release(token);
    }
  }

  private async readPlugins(busy: "loading" | "refreshing") {
    if (!this.acquire(true)) return;
    const token = this.revision;
    try {
      await this.fetchPlugins(token, busy);
    } finally {
      this.release(token);
    }
  }

  private async fetchPlugins(token: number, busy: "loading" | "refreshing") {
    try {
      if (!this.services.available()) throw new Error("桌面运行时未连接，已安装插件清单需在桌面应用中读取");
      this.patch({ busy, busyPluginId: null, error: "", refreshError: "", messageKind: "progress", message: "正在读取插件清单" });
      const result: unknown = await this.services.listPlugins();
      const plugins = parseInstalledPluginList(result);
      if (!this.isCurrent(token)) return;
      this.catalogueReadFailed = false;
      this.state = { ...this.state, plugins: [...plugins], refreshError: "", messageKind: "read-success", message: `已读取 ${plugins.length} 个插件` };
      if (this.readbackPending) {
        this.readbackPending = false;
        this.state = { ...this.state, messageKind: "action-success", message: `${this.state.committedAction?.title ?? "插件操作"}已完成，清单已重新读取` };
      }
      this.publish();
    } catch (error) {
      if (this.isCurrent(token)) {
        const message = this.readbackPending
          ? `${this.state.committedAction?.title ?? "插件操作"}已完成，但清单读取失败；重试读取即可，不会重复执行操作`
          : "插件清单读取失败，请重试读取清单";
        this.catalogueReadFailed = true;
        this.state = { ...this.state, refreshError: errorMessage(error),
          messageKind: this.readbackPending ? "readback-recovery" : "read-failure", message };
        this.publish();
      }
    }
  }

  private async commitAndRefresh(token: number, action: PluginInventoryCommittedAction, returnedPlugin?: InstalledPlugin, warning?: string) {
    if (!this.isCurrent(token)) return;
    this.readbackPending = true;
    this.state = {
      ...this.state,
      ...(returnedPlugin ? { plugins: mergeReturnedPlugin(this.state.plugins, returnedPlugin, action.kind) } : {}),
      lastChangedId: action.pluginId || null,
      commitRevision: this.state.commitRevision + 1,
      committedAction: action,
      error: "",
      refreshError: "",
      messageKind: "progress", message: `${action.title}已完成，正在读取插件清单`,
    };
    this.publish();
    this.patch({ busy: "refreshing" });
    await this.fetchPlugins(token, "refreshing");
    if (!this.isCurrent(token)) return;
    if (this.readbackPending) {
      this.state = { ...this.state, messageKind: "readback-recovery", message: `${action.title}已完成，但清单刷新失败；重试读取即可，不会重复执行操作` };
      this.publish();
    } else {
      this.state = { ...this.state, messageKind: warning ? "warning" : "action-success", message: warning ? `${actionMessage(action)}；${warning}` : actionMessage(action) };
      this.publish();
    }
  }

  private acquire(allowReadbackPending = false): boolean {
    if (!this.alive || this.busyLock || ((this.readbackPending || this.catalogueReadFailed) && !allowReadbackPending)) return false;
    this.busyLock = true;
    this.revision += 1;
    return true;
  }

  private release(token: number) {
    if (token !== this.revision) return;
    this.busyLock = false;
    if (this.alive) this.patch({ busy: "idle", busyPluginId: null });
  }

  private findPlugin(id: string) { return this.state.plugins.find((plugin) => plugin.id === id); }
  private isCurrent(token: number) { return this.alive && token === this.revision; }
  private fail(error: unknown, prefix: string) {
    const detail = errorMessage(error);
    this.patch({ error: `${prefix}：${detail}`, messageKind: "action-failure", message: `${prefix}，请检查插件状态后重试` });
  }
  private patch(patch: Partial<PluginInventoryControllerState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...patch };
    this.publish();
  }
  private publish() { if (this.alive) this.onChange(this.snapshot); }
}

function pluginAction(plugin: InstalledPlugin, label: "更新插件" | "卸载插件" | "授权启用") {
  return pluginInventory([plugin], { selectedPluginId: plugin.id }).selectedPlugin?.actions.find((action) => action.label === label)
    ?? { label, available: false, reason: importedRequired };
}

function pluginTitle(plugin: InstalledPlugin) { return plugin.manifest.title?.trim() || plugin.name || plugin.id; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function manifestNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}
function manifestKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}
function actionMessage(action: PluginInventoryCommittedAction) {
  if (action.kind === "toggle") return `插件已${action.enabled ? "启用" : "停用"}`;
  if (action.kind === "uninstall") return "插件已卸载";
  if (action.kind === "authorize") return `已授权启用 ${action.title}`;
  return `${action.title}已${action.kind === "install" ? "安装" : "更新"}`;
}
function mergeReturnedPlugin(current: InstalledPlugin[], plugin: InstalledPlugin, kind: PluginInventoryCommittedAction["kind"]): InstalledPlugin[] {
  if (kind === "uninstall") return current.filter((item) => item.id !== plugin.id);
  const index = current.findIndex((item) => item.id === plugin.id);
  if (kind === "install" && index < 0) return [...current, plugin];
  if (index < 0) return current;
  return current.map((item, itemIndex) => itemIndex === index ? plugin : item);
}

function withoutSourceKind(plugin: InstalledPlugin): InstalledPlugin {
  const { source_kind: _untrustedSourceKind, ...untrustedFields } = plugin;
  return untrustedFields as InstalledPlugin;
}

function withVerifiedSourceKind(plugin: InstalledPlugin, sourceKind: InstalledPlugin["source_kind"]): InstalledPlugin {
  const sourceNeutral = withoutSourceKind(plugin);
  return sourceKind ? { ...sourceNeutral, source_kind: sourceKind } : sourceNeutral;
}
