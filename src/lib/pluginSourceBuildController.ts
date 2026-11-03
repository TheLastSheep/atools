import {
  inspectionFromRun, isSourceBuildTerminal, matchesSourceBuildInspectRun, matchesSourceBuildRun, sourceBuildInstalledPlugin,
  validSourceBuildInspection, validSourceBuildRuntime, type SourceBuildEntry, type SourceBuildIdentity,
  type SourceBuildInspectIdentity, type SourceBuildServices, type SourceBuildState,
} from "./pluginSourceBuildProtocol";
import { parseSourceManifestMetadata, requiresExplicitManifestChoice, type ManifestSelection } from "./pluginSourceBuildManifest";
import type { TaskRun } from "./types";

type Observation = { kind: "conversion"; identity: SourceBuildIdentity; checking: boolean; paused: boolean; cancelAcknowledged: boolean; errors: number; reads: number };
type InspectionObservation = { kind: "inspection"; identity: SourceBuildInspectIdentity; checking: boolean; paused: boolean; cancelAcknowledged: boolean; errors: number; reads: number };
type ActiveObservation = Observation | InspectionObservation;
const POLL_MS = 250;
const MAX_POLLS = 2400;

/** User-selected paths only. Both inspection and conversion use the shared durable TaskRun pipeline. */
export class PluginSourceBuildController {
  private state: SourceBuildState = { entries: {}, activePath: null };
  private closed = false;
  private observation?: ActiveObservation;
  private timer?: ReturnType<typeof setTimeout>;
  private stop?: () => void;
  private attaching?: Promise<void>;
  private cancelling?: ActiveObservation;

  constructor(private readonly services: SourceBuildServices, private readonly onChange: (state: SourceBuildState) => void) { this.publish(); }
  get snapshot() { return this.state; }

  async inspect(path: string, selection?: ManifestSelection) {
    if (this.closed || this.state.activePath) return;
    this.state.activePath = path;
    this.stopObserving();
    this.observation = undefined;
    this.patch(path, { phase: "checking", message: "", observationError: "", requestedManifestSelection: selection, manifestChoiceConfirmed: false, taskKind: "inspection" });
    try {
      const started = await this.services.inspect(path, selection);
      if (this.closed || this.state.activePath !== path) return;
      if (!started || typeof started.id !== "string" || !started.id || started.id.length > 128) throw Error("没有返回有效检查任务，请在结果中心确认状态。");
      const identity: SourceBuildInspectIdentity = { id: started.id, sourcePath: path, ...(selection ? { manifestSelection: selection } : {}) };
      if (!matchesSourceBuildInspectRun(started, identity)) throw Error("检查任务身份与本次源码不一致。");
      this.observation = { kind: "inspection", identity, checking: false, paused: false, cancelAcknowledged: false, errors: 0, reads: 0 };
      this.patch(path, { ...this.state.entries[path], runId: started.id, taskStatus: started.status, taskKind: "inspection" });
      if (isSourceBuildTerminal(started.status)) this.finishInspection(this.observation, started);
      else { void this.attach(); await this.check(this.observation); }
    } catch (error) {
      if (!this.closed && this.state.activePath === path) {
        this.observation = undefined;
        this.patch(path, { ...this.state.entries[path], phase: "failed", message: `检查请求未完成：${message(error)}`, observationError: "" });
        this.state.activePath = null; this.publish();
      }
    }
  }

  async convert(path: string) {
    const entry = this.state.entries[path];
    const inspection = entry?.inspection;
    const parsed = inspection ? parseSourceManifestMetadata(inspection) : null;
    const current = parsed?.kind === "current" ? parsed.value : undefined;
    const needsChoice = parsed ? requiresExplicitManifestChoice(parsed) : false;
    if (this.closed || this.state.activePath || entry?.phase !== "eligible" || !inspection?.sourceRevision
      || needsChoice && entry.manifestChoiceConfirmed !== true
      || current && (current.manifestSelection === null || current.manifestSha256 === null)) return;
    this.state.activePath = path;
    this.patch(path, { ...entry, phase: "starting", message: "", observationError: "", runtime: undefined, taskKind: "conversion" });
    try {
      const started = await this.services.start(path, inspection.sourceRevision, current?.manifestSelection ?? undefined, current?.manifestSha256 ?? undefined);
      if (this.closed) return;
      if (!started || typeof started.id !== "string" || !started.id || started.id.length > 128) throw Error("没有返回有效任务编号，请先在结果中心检查任务状态。");
      const identity: SourceBuildIdentity = {
        id: started.id, sourcePath: path, expectedRevision: inspection.sourceRevision, overwrite: true,
        ...(current ? { manifestSelection: current.manifestSelection as ManifestSelection, expectedManifestSha256: current.manifestSha256 as string } : {}),
      };
      this.observation = { kind: "conversion", identity, checking: false, paused: false, cancelAcknowledged: false, errors: 0, reads: 0 };
      this.patch(path, { ...this.state.entries[path], runId: started.id, taskKind: "conversion" });
      void this.attach();
      await this.check(this.observation);
    } catch (error) {
      if (!this.closed) {
        if (this.observation?.kind === "conversion") this.observationFailed(path, `暂时无法读取任务：${message(error)}`);
        else { this.state.activePath = null; this.patch(path, { ...this.state.entries[path], phase: "failed", message: `启动请求未完成：${message(error)}`, observationError: "" }); }
      }
    }
  }

  async cancel(path: string) {
    const current = this.observation;
    const entry = this.state.entries[path];
    const allowed = entry?.taskStatus === "created" || entry?.phase === "awaiting_permission" || entry?.runtime?.cancellable
      || current?.kind === "inspection" && entry?.taskStatus === "running";
    if (this.closed || this.state.activePath !== path || !current || this.cancelling === current || !allowed || current.cancelAcknowledged || entry?.runtime?.cancelRequested) return;
    this.cancelling = current;
    try {
      const run = await this.services.cancel(current.identity.id);
      if (!this.current(current)) return;
      const matches = current.kind === "inspection"
        ? matchesSourceBuildInspectRun(run, current.identity)
        : matchesSourceBuildRun(run, current.identity);
      if (!matches) throw Error("取消返回的任务身份不一致。");
      current.cancelAcknowledged = true;
      this.patch(path, { ...this.state.entries[path], phase: "cancelling", message: "已请求取消，正在等待任务结束…" });
      current.paused = false;
      await this.check(current);
    } catch (error) {
      if (this.current(current)) this.patch(path, { ...this.state.entries[path], message: `取消未完成：${message(error)}` });
    } finally { if (this.cancelling === current) this.cancelling = undefined; }
  }

  async resume(path: string) {
    if (this.closed || this.state.activePath !== path || !this.observation || this.observation.checking) return;
    this.observation.errors = 0; this.observation.reads = 0; this.observation.paused = false;
    this.patch(path, { ...this.state.entries[path], observationError: "" });
    void this.attach();
    await this.check(this.observation);
  }

  dispose() {
    this.closed = true; this.stopObserving(); this.observation = undefined; this.services.dispose?.();
  }

  private async attach() {
    if (this.stop || this.attaching) return this.attaching;
    this.attaching = this.services.listen(id => {
      if (this.observation?.identity.id === id && !this.timer && !this.observation.checking) void this.check(this.observation);
    }).then(stop => { if (this.closed || !this.observation || this.observation.paused) stop(); else this.stop = stop; })
      .catch(() => { /* Polling remains authoritative when event subscription is unavailable. */ })
      .finally(() => { this.attaching = undefined; });
    return this.attaching;
  }

  private async check(current: ActiveObservation) {
    if (!this.current(current) || current.paused || current.checking) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; current.checking = true;
    const path = current.identity.sourcePath;
    try {
      const run = await this.services.read(current.identity.id);
      if (!this.current(current)) return;
      current.reads += 1;
      const matches = current.kind === "inspection"
        ? matchesSourceBuildInspectRun(run, current.identity)
        : matchesSourceBuildRun(run, current.identity);
      if (!matches || !run) { this.observationFailed(path, "任务身份与本次操作不一致，已停止读取。请到结果中心检查。"); return; }
      if (isSourceBuildTerminal(run.status)) {
        if (current.kind === "inspection") this.finishInspection(current, run);
        else await this.finish(current, run);
        return;
      }
      if (current.kind === "inspection") {
        current.errors = 0;
        const phase = current.cancelAcknowledged || run.status === "cancelled" ? "cancelling"
          : run.status === "awaiting_permission" ? "awaiting_permission" : "checking";
        this.patch(path, { ...this.state.entries[path], phase, taskStatus: run.status, message: phase === "awaiting_permission" ? "等待你在授权弹窗中允许读取源码清单。" : "正在读取所选源码清单…" });
      } else {
        const runtime = await this.services.runtime(run.id);
        if (!this.current(current)) return;
        if (!validSourceBuildRuntime(runtime)) throw Error("转换进度返回了无效结果。");
        current.errors = 0;
        const phase = current.cancelAcknowledged || runtime.cancelRequested || runtime.stage === "cancelling" ? "cancelling"
          : run.status === "awaiting_permission" ? "awaiting_permission"
          : ["preparing", "building", "installing"].includes(runtime.stage) ? runtime.stage as "preparing" | "building" | "installing" : "preparing";
        this.patch(path, { ...this.state.entries[path], phase, runtime, taskStatus: run.status, observationError: "" });
      }
      if (current.reads >= MAX_POLLS) { this.observationFailed(path, "任务仍未结束，已暂停自动读取。可继续读取或到结果中心查看。"); return; }
    } catch (error) {
      if (!this.current(current)) return;
      current.errors += 1;
      if (current.errors >= 3) { this.observationFailed(path, `无法读取任务状态：${message(error)}`); return; }
    } finally {
      current.checking = false;
      if (this.current(current) && !current.paused) this.timer = setTimeout(() => { void this.check(current); }, POLL_MS);
    }
  }

  private finishInspection(current: InspectionObservation, run: TaskRun) {
    const path = current.identity.sourcePath;
    this.stopObserving(); this.observation = undefined; this.state.activePath = null;
    const inspection = run.status === "succeeded" ? inspectionFromRun(run) : null;
    const parsed = inspection ? parseSourceManifestMetadata(inspection) : null;
    const requested = current.identity.manifestSelection;
    const selectedMatches = requested === undefined || parsed?.kind === "current" && parsed.value.manifestSelection === requested;
    if (inspection && validSourceBuildInspection(inspection) && selectedMatches) {
      const choiceConfirmed = requested !== undefined;
      this.patch(path, { ...this.state.entries[path], phase: inspection.status, inspection, taskStatus: run.status,
        manifestChoiceConfirmed: choiceConfirmed, message: "", observationError: "" });
    } else {
      const detail = run.status === "cancelled" ? "源码检查已取消。" : !selectedMatches
        ? "返回的清单与本次选择不一致，已停止检查。请重新选择后再试。"
        : run.errors?.[0]?.message || run.summary || "源码检查未完成，请重试。";
      this.patch(path, { ...this.state.entries[path], phase: run.status === "cancelled" ? "cancelled" : "failed", taskStatus: run.status, message: detail, observationError: "" });
    }
    this.publish();
  }

  private async finish(current: Observation, run: TaskRun) {
    const path = current.identity.sourcePath;
    const entry = this.state.entries[path];
    const pluginId = run.status === "succeeded" && entry.inspection
      ? sourceBuildInstalledPlugin(run, entry.inspection, current.identity.expectedRevision) : null;
    this.stopObserving(); this.observation = undefined; this.state.activePath = null;
    if (run.status === "succeeded" && pluginId) {
      this.patch(path, { ...entry, phase: "succeeded", runtime: undefined, message: "转换并安装已完成。", observationError: "" });
      try { await this.services.installed(pluginId); }
      catch (error) { if (!this.closed) this.patch(path, { ...this.state.entries[path], message: `转换并安装已完成，但读取插件列表失败：${message(error)}` }); }
    } else {
      const phase = run.status === "cancelled" ? "cancelled" : "failed";
      const permissionRequestWasDismissed = run.status === "cancelled" && !run.errors?.length && run.summary === "Permission request was dismissed";
      const detail = run.status === "succeeded" ? "安装结果身份不一致，请到结果中心检查。"
        : run.errors?.[0]?.message || (permissionRequestWasDismissed ? "本次转换未获授权。可重新检查后再次发起，并在授权弹窗中自行决定是否允许。"
          : run.summary || (phase === "cancelled" ? "转换已取消。" : "转换未完成，可重新检查后重试。"));
      this.patch(path, { ...entry, phase, runtime: undefined, message: detail, observationError: "" });
    }
  }

  private current(observation: ActiveObservation) { return !this.closed && this.observation === observation; }
  private observationFailed(path: string, observationError: string) {
    if (this.observation) this.observation.paused = true;
    this.stopObserving(); this.patch(path, { ...this.state.entries[path], observationError });
  }
  private stopObserving() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.stop?.(); this.stop = undefined; }
  private patch(path: string, entry: SourceBuildEntry) { this.state = { ...this.state, entries: { ...this.state.entries, [path]: entry } }; this.publish(); }
  private publish() { if (!this.closed) this.onChange({ ...this.state, entries: { ...this.state.entries } }); }
}

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
