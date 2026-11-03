import { normalizePluginMarketRequest, type PluginMarketRequest } from "./pluginMarketNavigation";
import { marketTargetStatus, needsOfficialMarketPreflight, readOfficialMarketTarget, type MarketTargetState } from "./pluginMarketTarget";
import { createMarketInstallIntent, marketInstallConfirmation, retargetMarketInstallIntent, type MarketInstallIntent } from "./pluginMarketInstallIntent";
import type { InstalledPlugin, PluginMarketCatalog, PluginMarketResolvedDownload } from "./types";
import { DEFAULT_ZTOOLS_MARKET_URL, marketInstallAllowed, marketOfficialUnsigned, preferredMarketUrl,
  type MarketConfirm, type MarketPreferences, type PluginMarketProgress } from "./pluginMarketView";
import { presentPluginInstallProblem } from "./pluginInstallProblem";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type MarketState = {
  loading: boolean; catalog: PluginMarketCatalog | null; installed: InstalledPlugin[];
  sourceUrl: string; officialOverride: boolean; target: string | null; query: string;
  selectedId: string | null; status: string; pendingId: string; operationId: string;
  progress: PluginMarketProgress | null; retry: MarketInstallIntent | null; recentlyInstalled: InstalledPlugin | null;
  installFailure: string;
  targetLookup: MarketTargetState | null; installTarget: MarketTargetState | null;
};
export type PluginMarketDependencies = {
  invoke: Invoke; hasRuntime: () => boolean; confirm: (request: MarketConfirm) => Promise<boolean>;
  onInstalled?: (plugin: InstalledPlugin, installed: InstalledPlugin[], operation: "install" | "update") => void;
};

/** Owns catalog races and the complete resolve → confirm → mutation transaction. */
export class PluginMarketController {
  state: MarketState = { loading: false, catalog: null, installed: [], sourceUrl: DEFAULT_ZTOOLS_MARKET_URL,
    officialOverride: false, target: null, query: "", selectedId: null, status: "", pendingId: "",
    operationId: "", progress: null, retry: null, recentlyInstalled: null, installFailure: "",
    targetLookup: null, installTarget: null };
  private preferences: MarketPreferences = { custom: false, url: "", trustedPublicKeys: "" };
  private request: PluginMarketRequest | null | undefined;
  private configured = false;
  private revision = 0;
  private installedRevision = 0;
  private transaction = 0;
  private executing = false;
  private alive = true;
  private listeners = new Set<(state: MarketState) => void>();
  constructor(private dependencies: PluginMarketDependencies) {}
  connect(dependencies: PluginMarketDependencies) {
    this.dependencies = dependencies;
    return () => {
      if (this.dependencies === dependencies) this.dependencies = { ...dependencies, confirm: async () => false, onInstalled: undefined };
    };
  }

  subscribe(listener: (state: MarketState) => void) {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private set(patch: Partial<MarketState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener(this.state));
  }
  dispose() { this.alive = false; this.revision++; this.listeners.clear(); }
  /** Leave the page without dropping an already confirmed mutation or its lock. */
  leave() {
    this.revision++;
    this.configured = false;
    if (!this.executing) {
      this.transaction++;
      this.set({ pendingId: "", operationId: "", progress: null });
    }
    this.set({ loading: false, officialOverride: false, target: null, query: "", selectedId: null,
      catalog: null, installed: [], targetLookup: null, installTarget: null, installFailure: "",
      sourceUrl: preferredMarketUrl(this.preferences) });
  }
  clearIdleCache() {
    if (!this.state.pendingId && (this.state.catalog || this.state.installed.length || this.state.progress))
      this.set({ catalog: null, installed: [], progress: null });
  }

  configure(preferences: MarketPreferences, request?: PluginMarketRequest | null) {
    const previousSource = this.state.sourceUrl;
    // A null prop means no new navigation; consuming a request must not reset this visit.
    const changedRequest = Boolean(request && request !== this.request);
    this.preferences = { ...preferences };
    if (changedRequest) {
      this.request = request;
      const normalized = normalizePluginMarketRequest(request);
      this.set({ officialOverride: Boolean(normalized), target: normalized?.pluginName ?? null,
        query: "", selectedId: normalized?.pluginName ?? null });
    }
    const sourceUrl = this.state.officialOverride ? DEFAULT_ZTOOLS_MARKET_URL : preferredMarketUrl(preferences);
    this.set({ sourceUrl, ...(changedRequest || previousSource !== sourceUrl ? { installFailure: "" } : {}) });
    if (!this.configured || changedRequest || previousSource !== sourceUrl) {
      this.configured = true;
      void this.refresh();
    }
  }
  clearTarget() {
    this.set({ target: null, targetLookup: null, query: "", selectedId: null });
    void this.refresh();
  }
  restoreSource() {
    this.set({ officialOverride: false, target: null, targetLookup: null, query: "", selectedId: null,
      sourceUrl: preferredMarketUrl(this.preferences) });
    void this.refresh();
  }
  setQuery(query: string) { this.set({ query, selectedId: null }); }
  select(id: string) { this.set({ selectedId: id, installFailure: "" }); }
  clearRecentlyInstalled() { this.set({ recentlyInstalled: null }); }

  async refresh() {
    const revision = ++this.revision;
    const installedRevision = this.installedRevision;
    const sourceUrl = this.state.sourceUrl; // Freeze before the first asynchronous boundary.
    const target = this.state.officialOverride ? this.state.target : null;
    this.set({ loading: true, catalog: null, selectedId: null, installTarget: null, installFailure: "",
      targetLookup: target ? { id: target, status: "loading" } : null,
      status: target ? "正在查询官方发布信息" : "正在读取本次来源目录" });
    if (!this.dependencies.hasRuntime()) {
      this.set({ loading: false, installed: [], status: "Tauri 运行时未连接，插件目录需在桌面应用中查看" });
      return;
    }
    try {
      const [installed, result] = await Promise.all([
        this.dependencies.invoke<InstalledPlugin[]>("list_plugins"),
        target ? readOfficialMarketTarget(this.dependencies.invoke, target)
          : this.dependencies.invoke<PluginMarketCatalog>("fetch_plugin_market_catalog", { url: sourceUrl })
            .then(catalog => ({ catalog, target: null })),
      ]);
      if (!this.alive || revision !== this.revision) return;
      const currentInstalled = installedRevision === this.installedRevision ? installed : this.state.installed;
      const { catalog, target: targetLookup } = result;
      this.set({ installed: currentInstalled, catalog, targetLookup, selectedId: this.state.target
        ? catalog.plugins.find(plugin => plugin.id === this.state.target)?.id ?? null : null,
        status: targetLookup ? marketTargetStatus(targetLookup)
          : `已读取 ${currentInstalled.length} 个已安装插件；本次目录返回 ${catalog.plugins.length} 个条目` });
    } catch (error) {
      if (revision === this.revision) this.set(target
        ? { targetLookup: { id: target, status: "error", error: String(error) }, status: "官方发布信息查询失败，可重试" }
        : { status: `目录读取失败：${String(error)}` });
    } finally {
      if (revision === this.revision) this.set({ loading: false });
    }
  }

  handleProgress(event: PluginMarketProgress) {
    // Missing IDs and broadcasts for another transaction cannot replace current progress.
    if (!this.state.operationId || event.operation_id !== this.state.operationId) return;
    this.set({ progress: event });
  }

  async cancel() {
    const operationId = this.state.operationId;
    if (!operationId) return;
    this.set({ status: "正在取消插件市场任务" });
    try { await this.dependencies.invoke("cancel_plugin_market_operation", { operationId }); }
    catch (error) { if (this.state.operationId === operationId) this.set({ status: String(error) }); }
  }

  async install(pluginId: string) {
    if (this.state.pendingId || this.state.loading || !this.state.catalog) return;
    const catalog = this.state.catalog;
    const plugin = catalog.plugins.find(plugin => plugin.id === pluginId);
    if (!plugin) return;
    await this.runInstall(createMarketInstallIntent(plugin, catalog, this.preferences.trustedPublicKeys, this.state.installed));
  }

  async retry() {
    if (this.state.pendingId || !this.state.retry) return;
    // Keep the original source and operation; official releases are checked again before a new approval.
    await this.runInstall(this.state.retry);
  }

  private async runInstall(snapshot: MarketInstallIntent) {
    const previousVersion = snapshot.plugin.version;
    let { plugin, actionLabel } = snapshot;
    const { operation } = snapshot;
    if (!this.dependencies.hasRuntime()) { this.set({ status: `浏览器预览模式无法安装：${plugin.name}` }); return; }
    const source = { source_kind: snapshot.sourceKind, source_url: snapshot.sourceUrl };
    if (!marketInstallAllowed(plugin, snapshot.trustedKeys, source)) {
      this.set({ status: `${plugin.name} 未提供受信签名，且不属于官方 ZTools 市场，已拒绝安装` }); return;
    }
    const revision = this.revision;
    const transaction = ++this.transaction;
    const current = () => this.alive && transaction === this.transaction;
    const valid = () => current() && revision === this.revision;
    this.set({ pendingId: plugin.id, retry: null, progress: null, installTarget: null, installFailure: "", status: `正在检查 ${plugin.name} 的发布信息` });
    let executing = false;
    try {
      if (needsOfficialMarketPreflight(source)) {
        this.set({ installTarget: { id: plugin.id, name: plugin.name, status: "loading" } });
        let result: Awaited<ReturnType<typeof readOfficialMarketTarget>>;
        try { result = await readOfficialMarketTarget(this.dependencies.invoke, plugin.id); }
        catch (error) {
          if (valid()) this.set({ installTarget: { id: plugin.id, name: plugin.name, status: "error", error: String(error) },
            retry: snapshot, status: `${plugin.name} 的官方发布信息查询失败；未开始下载安装` });
          return;
        }
        if (!valid()) { if (current()) this.set({ status: "目录来源已变化，本次安装检查已停止，请重新选择" }); return; }
        this.set({ installTarget: { ...result.target, name: result.target.name || plugin.name } });
        const latest = result.catalog.plugins[0];
        if (!latest) {
          this.set({ retry: result.target.status === "not_found" ? snapshot : null,
            status: `${plugin.name}：${marketTargetStatus(result.target)}；未开始下载安装` });
          return;
        }
        snapshot = retargetMarketInstallIntent(snapshot, latest);
        ({ plugin, actionLabel } = snapshot);
        // Replace only the clicked row. Query, selection, scroll and the rest of the directory stay intact.
        const catalog = this.state.catalog;
        if (catalog?.source_kind === snapshot.sourceKind && catalog.source_url === snapshot.sourceUrl)
          this.set({ catalog: { ...catalog, plugins: catalog.plugins.map(item => item.id === plugin.id ? { ...plugin } : item) } });
        if (!marketInstallAllowed(plugin, snapshot.trustedKeys, source)) {
          this.set({ status: `${plugin.name} 的当前发布信息没有受信签名，已拒绝安装` }); return;
        }
      }
      this.set({ status: `正在解析 ${plugin.name} v${plugin.version} 的发布包` });
      const resolved = await this.dependencies.invoke<PluginMarketResolvedDownload>("resolve_plugin_market_download", { plugin });
      if (!valid()) { if (current()) this.set({ status: "目录来源已变化，本次安装已停止，请重新选择" }); return; }
      const officialUnsigned = marketOfficialUnsigned(plugin, source);
      const confirmed = await this.dependencies.confirm(marketInstallConfirmation(snapshot, resolved, officialUnsigned, previousVersion));
      if (!valid()) { if (current()) this.set({ status: "目录来源已变化，本次确认已失效，请重新选择" }); return; }
      if (!confirmed) { this.set({ status: `已取消${actionLabel} ${plugin.name}` }); return; }
      const operationId = `plugin-market-${plugin.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      executing = true;
      this.executing = true;
      this.set({ operationId, status: `正在下载并${actionLabel} ${plugin.name}`, progress: {
        plugin_id: plugin.id, operation, operation_id: operationId, stage: "requesting", downloaded_bytes: 0,
        total_bytes: null, percent: null, attempt: 1, max_attempts: 3, message: "正在连接插件市场" } });
      const updated = await this.dependencies.invoke<InstalledPlugin>(operation === "update" ? "update_plugin_from_market" : "install_plugin_from_market", {
        pluginId: plugin.id, expectedVersion: plugin.version, downloadUrl: resolved.download_url, checksum: plugin.checksum ?? null,
        signature: plugin.signature ?? null, publicKey: plugin.public_key ?? null, operationId,
        sourceKind: snapshot.sourceKind, sourceUrl: snapshot.sourceUrl, confirmedUnsigned: officialUnsigned,
      });
      if (!this.alive) return;
      this.installedRevision++;
      // A successful mutation must never become an install retry because a read/observer failed.
      let installed = [...this.state.installed.filter(item => item.id !== updated.id), updated];
      this.set({ installed, retry: null, installFailure: "", recentlyInstalled: updated, status: `已${actionLabel} ${updated.name || updated.id}` });
      try {
        installed = await this.dependencies.invoke<InstalledPlugin[]>("list_plugins");
        if (!this.alive) return;
        this.set({ installed });
      } catch (error) {
        this.set({ status: `已${actionLabel} ${updated.name || updated.id}；已安装列表刷新失败，可刷新目录重试读取：${String(error)}` });
      }
      try { this.dependencies.onInstalled?.(updated, installed, operation); }
      catch (error) { this.set({ status: `已${actionLabel} ${updated.name || updated.id}；界面更新失败，可刷新目录：${String(error)}` }); }
    } catch (error) {
      if (valid()) {
        const rawError = String(error);
        const installProblem = presentPluginInstallProblem(rawError, "market-install");
        this.set({ retry: executing && !installProblem ? snapshot : null,
          installFailure: installProblem ? rawError : "",
          status: installProblem ? "安装未完成：请查看原因和处理建议" : rawError });
      }
    } finally {
      if (current()) { this.executing = false; this.set({ pendingId: "", operationId: "" }); }
    }
  }
}
