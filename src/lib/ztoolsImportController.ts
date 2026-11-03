import type { InstalledPlugin, ZToolsImportCandidate, ZToolsImportReport } from "./types";
import { PluginCatalogObservation } from "./pluginCatalogObservation";
import { importCandidateIdentity, retryImportPaths, safeImportPaths, selectUnambiguousImportSources, toggleImportSource } from "./ztoolsImportSelection";
import type { ImportScanRoot, ZToolsImportSelectionSession } from "./ztoolsImportSelectionSession";

export type ImportBusy = "idle" | "scanning" | "choosing-directory" | "choosing-archive" | "importing" | "refreshing" | "enabling";
export type ZToolsImportState = {
  candidates: ZToolsImportCandidate[];
  selected: Set<string>;
  report: ZToolsImportReport | null;
  importedPlugins: Record<string, InstalledPlugin>;
  busy: ImportBusy;
  error: string;
  refreshError: string;
  enableErrors: Record<string, string>;
  pendingEnableRefresh: Set<string>;
};

export type ZToolsImportServices = {
  scanDefault: () => Promise<ZToolsImportCandidate[]>;
  scanPath: (path: string) => Promise<ZToolsImportCandidate[]>;
  chooseDirectory: () => Promise<string | null>;
  chooseArchive: () => Promise<string | null>;
  importPaths: (paths: string[]) => Promise<ZToolsImportReport>;
  listPlugins: () => Promise<InstalledPlugin[]>;
  enablePlugin: (pluginId: string) => Promise<void>;
};

const initialState = (): ZToolsImportState => ({
  candidates: [], selected: new Set(), report: null, importedPlugins: {},
  busy: "idle", error: "", refreshError: "", enableErrors: {}, pendingEnableRefresh: new Set(),
});

/** Owns one import session. In-flight native imports are allowed to finish; only stale UI results are ignored. */
export class ZToolsImportController {
  private state = initialState();
  private revision = 0;
  private readonly catalog = new PluginCatalogObservation();
  private activeScanRoot: ImportScanRoot | null = null;

  constructor(
    private readonly services: ZToolsImportServices,
    private readonly onChange: (state: ZToolsImportState) => void,
    private readonly selectionSession?: ZToolsImportSelectionSession,
  ) {
    this.publish();
  }

  get snapshot(): ZToolsImportState { return this.state; }

  dispose() {
    if (this.activeScanRoot) this.selectionSession?.remember(this.activeScanRoot, this.state.candidates, this.state.selected);
    this.revision += 1;
    this.catalog.dispose();
  }

  async scanDefault() {
    await this.scan({ kind: "default" }, () => this.services.scanDefault());
  }

  async scanPath(path: string) { await this.scan({ kind: "path", path }, () => this.services.scanPath(path)); }

  /** Called only after a matching conversion TaskRun durably succeeded and identified the installed plugin. */
  async registerConvertedPlugin(pluginId: string) {
    if (this.state.busy !== "idle") throw Error("插件列表正在更新，请稍后重新读取。");
    const token = ++this.revision;
    const previous = this.state.report ?? { imported: [], skipped: [], failed: [] };
    this.patch({ busy: "refreshing", report: { ...previous, imported: [...new Set([...previous.imported, pluginId])] }, refreshError: "" });
    try { await this.refreshImportedPlugins(token, "转换并安装已完成"); }
    finally { if (this.isCurrent(token)) this.patch({ busy: "idle" }); }
  }

  async chooseDirectory() {
    await this.chooseAndScan("choosing-directory", () => this.services.chooseDirectory());
  }

  async chooseArchive() {
    await this.chooseAndScan("choosing-archive", () => this.services.chooseArchive());
  }

  private async chooseAndScan(busy: ImportBusy, choose: () => Promise<string | null>) {
    if (this.state.busy !== "idle") return;
    const token = ++this.revision;
    this.patch({ busy, error: "" });
    try {
      const path = await choose();
      if (!this.isCurrent(token)) return;
      if (path === null) return;
      this.patch({ busy: "scanning" });
      const candidates = await this.services.scanPath(path);
      if (this.isCurrent(token)) await this.replaceCandidates(candidates, { kind: "path", path }, token);
    } catch (error) {
      if (this.isCurrent(token)) this.patch({ error: `扫描失败：${message(error)}` });
    } finally {
      if (this.isCurrent(token)) this.patch({ busy: "idle" });
    }
  }

  private async scan(root: ImportScanRoot, scan: () => Promise<ZToolsImportCandidate[]>) {
    if (this.state.busy !== "idle") return;
    const token = ++this.revision;
    this.patch({ busy: "scanning", error: "" });
    try {
      const candidates = await scan();
      if (this.isCurrent(token)) await this.replaceCandidates(candidates, root, token);
    } catch (error) {
      if (this.isCurrent(token)) this.patch({ error: `扫描失败：${message(error)}` });
    } finally {
      if (this.isCurrent(token)) this.patch({ busy: "idle" });
    }
  }

  private async replaceCandidates(candidates: ZToolsImportCandidate[], root: ImportScanRoot, token: number) {
    if (!this.isCurrent(token)) return;
    this.selectionSession?.touchForRestore(root);
    if (this.activeScanRoot) {
      this.selectionSession?.remember(this.activeScanRoot, this.state.candidates, this.state.selected);
    }
    let selected = selectUnambiguousImportSources(candidates);
    if (this.selectionSession?.has(root)) {
      try {
        const installed = await this.catalog.read(() => this.services.listPlugins());
        if (!this.isCurrent(token)) return;
        selected = this.selectionSession.restore(root, candidates, installed);
      } catch {
        if (!this.isCurrent(token)) return;
        this.selectionSession.clearRoot(root);
      }
    }
    if (!this.isCurrent(token)) return;
    this.revision += 1;
    this.activeScanRoot = root;
    this.state = {
      candidates,
      selected,
      report: null,
      importedPlugins: {},
      busy: "idle",
      error: "",
      refreshError: "",
      enableErrors: {},
      pendingEnableRefresh: new Set(),
    };
    this.publish();
  }

  toggle(path: string, checked: boolean) {
    if (this.state.busy !== "idle") return;
    this.patch({ selected: toggleImportSource(this.state.candidates, this.state.selected, path, checked) });
  }

  selectAll() {
    if (this.state.busy !== "idle") return;
    this.patch({ selected: selectUnambiguousImportSources(this.state.candidates, this.state.selected) });
  }

  clearSelection() {
    if (this.state.busy !== "idle") return;
    this.patch({ selected: new Set() });
  }

  async importSelected() {
    const paths = safeImportPaths(this.state.candidates, this.state.selected);
    await this.importSnapshot(paths);
  }

  async retryFailures() {
    const failures = this.state.report?.failed ?? [];
    const paths = retryImportPaths(this.state.candidates, failures.map(item => item.path), this.state.selected);
    if (this.state.busy === "idle" && failures.length > 0 && paths.length === 0) {
      this.patch({ error: "失败项存在来源冲突或已有其他选择，请选择一个来源后使用导入按钮。" });
    }
    await this.importSnapshot(paths);
  }

  private async importSnapshot(paths: string[]) {
    paths = safeImportPaths(this.state.candidates, paths);
    if (this.state.busy !== "idle" || paths.length === 0) return;
    const token = ++this.revision;
    this.patch({ busy: "importing", error: "", refreshError: "" });
    try {
      const report = await this.services.importPaths([...paths]);
      if (!this.isCurrent(token)) return;
      const selected = new Set(this.state.selected);
      const attemptedPaths = new Set(paths);
      attemptedPaths.forEach(path => selected.delete(path));
      for (const failure of report.failed) {
        if (attemptedPaths.has(failure.path)) selected.add(failure.path);
      }
      this.patch({ report: mergeReports(this.state.report, report, paths, this.state.candidates), selected: new Set(safeImportPaths(this.state.candidates, selected)), importedPlugins: {} });
      // The import report is durable UI state. A failed catalog refresh must not turn it into an import error.
      this.patch({ busy: "refreshing" });
      await this.refreshImportedPlugins(token, "导入已完成");
    } catch (error) {
      if (this.isCurrent(token)) this.patch({ error: `导入请求失败：${message(error)}` });
    } finally {
      if (this.isCurrent(token)) this.patch({ busy: "idle" });
    }
  }

  async retryPluginList() {
    if (this.state.busy !== "idle" || !this.state.report || this.state.report.imported.length === 0) return;
    const token = ++this.revision;
    this.patch({ busy: "refreshing", refreshError: "" });
    try { await this.refreshImportedPlugins(token); }
    finally { if (this.isCurrent(token)) this.patch({ busy: "idle" }); }
  }

  async retryEnabledPluginList(pluginId: string) {
    if (this.state.busy !== "idle" || !this.state.pendingEnableRefresh.has(pluginId)) return;
    const token = ++this.revision;
    this.patch({ busy: "refreshing", refreshError: "" });
    try { await this.refreshImportedPlugins(token, "插件已启用"); }
    finally { if (this.isCurrent(token)) this.patch({ busy: "idle" }); }
  }

  async enableAndRefresh(pluginId: string) {
    if (this.state.busy !== "idle" || !this.state.report?.imported.includes(pluginId)) return;
    const token = ++this.revision;
    const enableErrors = { ...this.state.enableErrors };
    delete enableErrors[pluginId];
    this.patch({ busy: "enabling", enableErrors, refreshError: "" });
    try {
      await this.services.enablePlugin(pluginId);
      if (!this.isCurrent(token)) return;
      const pendingEnableRefresh = new Set(this.state.pendingEnableRefresh);
      pendingEnableRefresh.add(pluginId);
      this.patch({ busy: "refreshing", pendingEnableRefresh });
      await this.refreshImportedPlugins(token, "插件已启用");
    } catch (error) {
      if (this.isCurrent(token)) {
        this.patch({ enableErrors: { ...this.state.enableErrors, [pluginId]: `启用失败：${message(error)}` } });
      }
    } finally {
      if (this.isCurrent(token)) this.patch({ busy: "idle" });
    }
  }

  private async refreshImportedPlugins(token: number, completedAction = "导入已完成") {
    try {
      const plugins = await this.catalog.read(() => this.services.listPlugins());
      if (!this.isCurrent(token)) return;
      const importedIds = new Set(this.state.report?.imported ?? []);
      const importedPlugins = Object.fromEntries(plugins.filter(plugin => importedIds.has(plugin.id)).map(plugin => [plugin.id, plugin]));
      const pendingEnableRefresh = new Set(this.state.pendingEnableRefresh);
      for (const plugin of plugins) if (plugin.enabled) pendingEnableRefresh.delete(plugin.id);
      this.patch({ importedPlugins, pendingEnableRefresh, refreshError: "" });
    } catch (error) {
      if (this.isCurrent(token)) this.patch({ refreshError: `${completedAction}，但读取插件列表失败：${message(error)}` });
    }
  }

  private isCurrent(token: number) { return token === this.revision; }

  private patch(patch: Partial<ZToolsImportState>) {
    this.state = { ...this.state, ...patch };
    this.publish();
  }

  private publish() { this.onChange({ ...this.state, selected: new Set(this.state.selected) }); }
}

function mergeReports(previous: ZToolsImportReport | null, next: ZToolsImportReport, attemptedPaths: string[], candidates: ZToolsImportCandidate[]): ZToolsImportReport {
  if (!previous) return next;
  const attempted = new Set(attemptedPaths);
  const candidatesByPath = new Map(candidates.map(candidate => [candidate.path, candidate]));
  const attemptedIdentities = new Set(candidates.filter(candidate => attempted.has(candidate.path)).map(importCandidateIdentity));
  const superseded = (path: string) => {
    const candidate = candidatesByPath.get(path);
    return attempted.has(path) || !!candidate && attemptedIdentities.has(importCandidateIdentity(candidate));
  };
  const failures = [...previous.failed.filter(item => !superseded(item.path)), ...next.failed];
  const skipped = [...previous.skipped.filter(item => !superseded(item.path)), ...next.skipped];
  return { imported: [...new Set([...previous.imported, ...next.imported])], skipped, failed: failures };
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
