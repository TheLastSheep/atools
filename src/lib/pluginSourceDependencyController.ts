import {
  dependencyTaskResult, isDependencyTerminal, matchesDependencyRun,
  type DependencyAction, type DependencyEntry, type DependencyIdentity, type DependencyServices,
  type DependencyInspection, type DependencyFetchResult, type DependencyPrepareResult,
  type DependencyState,
} from "./pluginSourceDependencyProtocol";
import type { TaskRun } from "./types";
import { pluginSourceDependencySession, type DependencyOperationSnapshot, type DependencySessionEvent } from "./pluginSourceDependencySession";

const POLL_MS = 250;
const MAX_POLLS = 2400;
const MAX_READ_ERRORS = 3;
type Observation = { identity: DependencyIdentity; reads: number; errors: number; checking: boolean; paused: boolean; cancelRequested: boolean };

/** Per-selected-row TaskRun observer. Closing it stops observation only; it never cancels native work. */
export class PluginSourceDependencyController {
  private state: DependencyState;
  private closed = false;
  private operationBusy = false;
  private observation?: Observation;
  private timer?: ReturnType<typeof setTimeout>;
  private stop?: () => void;
  private attaching?: Promise<void>;
  private cancelling?: Observation;
  private postPrepareRevision?: string;
  private readonly ownerToken = {};
  private sessionId?: number;
  private unsubscribeSession?: () => void;

  constructor(
    private readonly sourcePath: string,
    private readonly services: DependencyServices,
    private readonly onChange: (state: DependencyState) => void,
    private readonly onPrepared: () => void,
  ) {
    const shared = pluginSourceDependencySession.snapshot(sourcePath);
    this.sessionId = shared?.operationId;
    this.state = { activePath: pluginSourceDependencySession.activePath(),
      entry: shared?.entry ?? { sourcePath, phase: "idle", message: "", error: "" } };
    this.unsubscribeSession = pluginSourceDependencySession.subscribe(event => this.onSessionEvent(event));
    if (shared?.active && shared.identity) this.adopt(shared);
    else this.publish();
  }
  get snapshot() { return this.state; }
  get busy() { return !!this.state.activePath || this.operationBusy; }

  async inspect() {
    if (!this.canStart()) return;
    await this.start("inspect");
  }
  async fetch() {
    const inspection = this.state.entry?.inspection;
    if (!this.canStart() || !inspection || inspection.dependencySetPrepared || this.state.entry?.fetchResult) return;
    await this.start("fetch", inspection.sourceRevision);
  }
  async prepare() {
    const inspection = this.state.entry?.inspection;
    const fetched = this.state.entry?.fetchResult;
    if (!this.canStart() || !inspection || inspection.dependencySetPrepared || this.state.entry?.prepareResult
      || !fetched || !sameSet(inspection, fetched)) return;
    await this.start("prepare", inspection.sourceRevision);
  }
  async retry() {
    const action = this.entry().action;
    if (action === "fetch") return this.fetch();
    if (action === "prepare") return this.prepare();
    return this.inspect();
  }
  async recheck() {
    const entry = this.state.entry;
    if (this.closed || this.state.activePath || this.operationBusy || this.observation
      || !entry?.runId || !entry.taskStatus || !isDependencyTerminal(entry.taskStatus)
      || !["failed", "cancelled"].includes(entry.phase)) return;
    this.postPrepareRevision = undefined;
    this.patch({ ...entry, phase: "idle", action: "inspect", inspection: undefined,
      fetchResult: undefined, prepareResult: undefined, canResume: false, error: "", message: "" });
    await this.start("inspect");
  }
  async cancel() {
    const current = this.observation;
    if (this.closed || !current || this.cancelling === current || current.paused) return;
    const status = this.state.entry?.taskStatus;
    if (!status || !["created", "awaiting_permission", "running"].includes(status)) return;
    this.cancelling = current;
    try {
      const run = await this.services.cancel(current.identity.id);
      if (!this.current(current)) return;
      if (!matchesDependencyRun(run, current.identity)) {
        this.pauseObservation("取消响应身份不一致，已停止自动读取。请到结果中心检查。"); return;
      }
      current.cancelRequested = true;
      this.persistObservation(current);
      this.patch({ ...this.entry(), phase: "cancelling", message: "已请求取消，正在等待任务结束…", error: "" });
      await this.check(current);
    } catch {
      if (this.current(current)) this.patch({ ...this.entry(), message: "", error: "取消请求未完成。任务仍可能运行，可继续读取或到结果中心查看。" });
    } finally { if (this.cancelling === current) this.cancelling = undefined; }
  }
  async resume() {
    const current = this.observation;
    if (!current || !current.paused || this.closed) return;
    current.paused = false; current.errors = 0; current.reads = 0;
    this.persistObservation(current);
    this.patch({ ...this.entry(), canResume: false, error: "", message: "继续读取任务状态…" });
    void this.attach();
    await this.check(current);
  }
  dispose() {
    this.closed = true;
    this.stopObserving();
    if (this.sessionId !== undefined) pluginSourceDependencySession.releaseObserver(this.sessionId, this.ownerToken);
    this.observation = undefined;
    this.unsubscribeSession?.(); this.unsubscribeSession = undefined;
    this.services.dispose?.();
    // The shared session retains the gate and identity; only this observer is released.
  }

  private canStart() { return !this.closed && !pluginSourceDependencySession.activePath()
    && !this.state.activePath && !this.operationBusy && !this.observation; }
  private async start(action: DependencyAction, expectedRevision?: string) {
    if (!this.canStart()) return;
    this.operationBusy = true;
    const entry = { ...this.entry(), phase: "starting" as const, action, runId: undefined, taskStatus: undefined,
      message: "正在等待创建依赖任务…", error: "" };
    const sessionId = pluginSourceDependencySession.begin(this.sourcePath, entry, this.ownerToken);
    if (sessionId === undefined) { this.operationBusy = false; return; }
    this.sessionId = sessionId;
    this.state.activePath = this.sourcePath;
    this.patch(entry);
    try {
      const started = await this.services.start(action, this.sourcePath, expectedRevision);
      if (!started || typeof started.id !== "string" || !started.id || started.id.length > 128) {
        this.patch({ ...this.entry(), phase: "observing", canResume: false, message: "", error: "任务启动响应无效，已停止依赖操作。请到结果中心检查。" });
        throw Error("没有返回有效任务编号，请到结果中心检查任务状态。");
      }
      const identity: DependencyIdentity = { id: started.id, action, sourcePath: this.sourcePath, sourceRevision: expectedRevision };
      if (!matchesDependencyRun(started, identity)) {
        this.patch({ ...this.entry(), phase: "observing", runId: identity.id, canResume: false, message: "", error: "任务身份与本次依赖操作不一致，已停止依赖操作。请到结果中心检查。" });
        throw Error("任务身份与本次依赖操作不一致，已停止读取。");
      }
      const current: Observation = { identity, reads: 0, errors: 0, checking: false, paused: false, cancelRequested: false };
      if (!this.closed) this.observation = current;
      const startedEntry = { ...this.entry(), runId: started.id, taskStatus: started.status,
        phase: phaseFor(started.status), canResume: false, message: "", error: "" };
      pluginSourceDependencySession.setIdentity(sessionId, identity, startedEntry, this.ownerToken,
        this.closed ? undefined : this.ownerToken);
      this.state = { ...this.state, entry: startedEntry };
      this.publish();
      if (this.closed) return;
      void this.attach();
      await this.check(current);
    } catch {
      if (this.observation) {
        if (!this.closed) this.pauseObservation("暂时无法读取依赖任务状态。任务仍在后台运行，可继续读取或到结果中心查看。");
      } else {
        this.state.activePath = this.sourcePath;
        this.patch({ ...this.entry(), phase: "observing", canResume: false, message: "", error: "无法确认依赖任务是否创建成功。为避免重复操作，已停止后续依赖操作，请到结果中心检查。" });
      }
    } finally { this.operationBusy = false; }
  }
  private async attach() {
    if (this.stop || this.attaching) return this.attaching;
    this.attaching = this.services.listen(id => {
      if (this.observation?.identity.id === id && !this.timer && !this.observation.checking) void this.check(this.observation);
    }).then(stop => {
      if (this.closed || !this.observation || this.observation.paused) stop(); else this.stop = stop;
    }).catch(() => { /* Polling remains authoritative. */ }).finally(() => { this.attaching = undefined; });
    return this.attaching;
  }
  private async check(current: Observation) {
    if (!this.current(current) || current.paused || current.checking) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    current.checking = true;
    try {
      const run = await this.services.read(current.identity.id);
      if (!this.current(current)) return;
      current.reads += 1;
      this.persistObservation(current);
      if (!matchesDependencyRun(run, current.identity)) {
        this.pauseObservation("任务身份与所选源码或依赖操作不一致，已停止读取。请到结果中心检查。");
        return;
      }
      if (isDependencyTerminal(run.status)) { await this.finish(current, run); return; }
      current.errors = 0;
      this.persistObservation(current);
      const phase = current.cancelRequested ? "cancelling" : run.status === "awaiting_permission" ? "awaiting_permission" : "running";
      this.patch({ ...this.entry(), phase, taskStatus: run.status, message: phase === "awaiting_permission" ? "等待你在授权队列中决定是否允许此操作。" : "依赖任务正在运行…", error: "" });
      if (current.reads >= MAX_POLLS) {
        this.pauseObservation("任务仍未结束，已暂停自动读取。可继续读取或到结果中心查看。"); return;
      }
    } catch {
      if (!this.current(current)) return;
      current.errors += 1;
      this.persistObservation(current);
      if (current.errors >= MAX_READ_ERRORS) { this.pauseObservation("暂时无法读取依赖任务状态。任务仍在后台运行，可继续读取或到结果中心查看。"); return; }
    } finally {
      current.checking = false;
      if (this.current(current) && !current.paused) this.timer = setTimeout(() => { void this.check(current); }, POLL_MS);
    }
  }
  private async finish(current: Observation, run: TaskRun) {
    const action = current.identity.action;
    this.patch({ ...this.entry(), taskStatus: run.status });
    if (run.status === "succeeded") {
      const result = dependencyTaskResult(run, action);
      if (!result) { this.pauseObservation("依赖操作返回了未知或无效结果，已停止后续操作。可到结果中心检查。"); return; }
      if (action === "inspect") {
        const inspected = result as DependencyInspection;
        if (inspected.status !== "eligible" || inspected.sourceRevision.length !== 64) {
          this.pauseObservation("依赖检查未返回受支持的结果，已停止后续操作。"); return;
        }
        const prior = this.entry().inspection;
        if (prior && prior.sourceRevision !== inspected.sourceRevision) {
          this.release(current);
          this.postPrepareRevision = undefined;
          this.patch({ ...this.entry(), phase: "failed", action: "inspect", taskStatus: run.status,
            inspection: undefined, fetchResult: undefined, prepareResult: undefined, canResume: false,
            message: "所选源码已变化；旧依赖状态已清除。请重新检查后再继续。", error: "" });
          return;
        }
        const prepared = this.entry().prepareResult;
        const completedPrepareCheck = this.postPrepareRevision === inspected.sourceRevision;
        const preparedMatch = inspected.dependencySetPrepared && !!inspected.dependencyTreeSha256
          && inspected.dependencyTreeBytes !== null && prepared?.sourceRevision === inspected.sourceRevision
          && prepared.dependencySetIdSha256 === inspected.dependencySetIdSha256
          && prepared.treeSha256 === inspected.dependencyTreeSha256
          && prepared.treeBytes === inspected.dependencyTreeBytes
          && prepared.nodeBinarySha256 === inspected.nodeBinarySha256
          && prepared.nodeBinaryBytes === inspected.nodeBinaryBytes
          && prepared.toolchainFingerprintSha256 === inspected.toolchainFingerprintSha256;
        if (completedPrepareCheck && !preparedMatch) {
          this.pauseObservation("依赖准备后的树或工具链身份未能复核，已停止后续操作。请到结果中心检查。"); return;
        }
        this.release(current);
        this.patch({ ...this.entry(), phase: "eligible", action, inspection: inspected, fetchResult: undefined,
          message: inspected.dependencySetPrepared ? "本地依赖准备状态已确认；请重新检查转换条件。" : "依赖检查完成。", error: "" });
        if (completedPrepareCheck && preparedMatch) {
          this.postPrepareRevision = undefined;
          this.onPrepared();
        }
        return;
      }
      const inspection = this.entry().inspection;
      const fetchResult = result as DependencyFetchResult;
      const prepareResult = result as DependencyPrepareResult;
      if (!inspection || result.sourceRevision !== inspection.sourceRevision
        || result.dependencySetIdSha256 !== inspection.dependencySetIdSha256
        || result.packageCount !== inspection.packageCount) {
        this.pauseObservation("依赖结果与当前检查的源码或依赖集合不一致，已停止后续操作。可到结果中心检查。"); return;
      }
      if (action === "fetch") {
        if (fetchResult.status !== "cached" || fetchResult.dependencySetPrepared !== false) {
          this.pauseObservation("下载结果不符合预期，已停止准备依赖。"); return;
        }
        this.release(current);
        this.patch({ ...this.entry(), phase: "succeeded", fetchResult,
          message: "构建依赖已下载并校验；尚未准备到本地构建目录。未运行安装脚本。", error: "" });
        return;
      }
      if (prepareResult.status !== "prepared" || prepareResult.nodeBinarySha256 !== inspection.nodeBinarySha256
        || prepareResult.nodeBinaryBytes !== inspection.nodeBinaryBytes
        || prepareResult.toolchainFingerprintSha256 !== inspection.toolchainFingerprintSha256) {
        this.pauseObservation("准备结果与已检查的工具链身份不一致，已停止后续操作。"); return;
      }
      this.release(current);
      this.postPrepareRevision = inspection.sourceRevision;
      this.patch({ ...this.entry(), phase: "checking", prepareResult,
        message: "依赖准备完成；正在重新检查转换条件。未运行安装脚本。", error: "" });
      this.operationBusy = false;
      await this.start("inspect");
      return;
    }
    this.release(current);
    const denied = run.status === "cancelled" && (!run.errors?.length)
      && run.summary === "Permission request was dismissed";
    const phase = run.status === "cancelled" ? "cancelled" : "failed";
    this.patch({ ...this.entry(), phase, taskStatus: run.status, message: "",
      error: denied ? "本次操作未获授权。你可以重新发起，并在授权队列中自行决定是否允许。"
        : phase === "cancelled" ? "依赖操作已取消。可重新检查后重试。"
          : "依赖操作未完成。可到结果中心查看任务详情后重试。" });
  }
  private release(current: Observation) {
    if (this.observation !== current) return;
    this.stopObserving(); this.observation = undefined;
    if (this.sessionId !== undefined) {
      pluginSourceDependencySession.releaseTerminal(this.sessionId, current.identity, this.entry(), this.ownerToken);
    }
    this.state.activePath = pluginSourceDependencySession.activePath();
  }
  private pauseObservation(error: string) {
    if (this.observation) this.observation.paused = true;
    if (this.observation) this.persistObservation(this.observation);
    this.stopObserving();
    this.patch({ ...this.entry(), phase: "observing", canResume: !!this.observation, message: "", error });
  }
  private persistObservation(current: Observation) {
    if (this.sessionId === undefined) return;
    pluginSourceDependencySession.updateObservation(this.sessionId, { reads: current.reads, errors: current.errors,
      paused: current.paused, cancelRequested: current.cancelRequested }, this.ownerToken);
  }
  private onSessionEvent(event: DependencySessionEvent) {
    if (this.closed || event.origin === this.ownerToken) return;
    if (this.sessionId !== undefined && event.operation?.operationId !== this.sessionId) {
      this.stopObserving();
      this.observation = undefined;
      this.sessionId = undefined;
      this.state.entry = { sourcePath: this.sourcePath, phase: "idle", message: "", error: "" };
    }
    this.state.activePath = event.activePath;
    const shared = event.operation?.sourcePath === this.sourcePath ? event.operation : undefined;
    if (shared) {
      this.sessionId = shared.operationId;
      this.state.entry = { ...shared.entry };
      if (shared.active && shared.identity && !this.observation) this.adopt(shared);
    }
    this.publish();
  }
  private adopt(shared: DependencyOperationSnapshot) {
    if (this.closed || !shared.active || !shared.identity || this.observation) return;
    const claimed = pluginSourceDependencySession.claimObserver(shared.operationId, this.ownerToken);
    if (!claimed?.identity) return;
    this.sessionId = claimed.operationId;
    const current: Observation = { identity: claimed.identity, reads: claimed.reads, errors: claimed.errors,
      checking: false, paused: claimed.paused, cancelRequested: claimed.cancelRequested };
    this.observation = current;
    this.state.activePath = pluginSourceDependencySession.activePath();
    this.state.entry = { ...claimed.entry, canResume: claimed.paused };
    this.publish();
    if (!current.paused) {
      void this.attach();
      void this.check(current);
    }
  }
  private current(current: Observation) { return !this.closed && this.observation === current; }
  private stopObserving() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.stop?.(); this.stop = undefined;
  }
  private entry(): DependencyEntry { return this.state.entry!; }
  private patch(entry: DependencyEntry) {
    this.state = { ...this.state, entry };
    if (this.sessionId !== undefined) pluginSourceDependencySession.updateEntry(this.sessionId, entry, this.ownerToken);
    this.publish();
  }
  private publish() { if (!this.closed) this.onChange({ ...this.state, entry: this.state.entry && { ...this.state.entry } }); }
}

function sameSet(a: NonNullable<DependencyEntry["inspection"]>, b: NonNullable<DependencyEntry["fetchResult"]>) {
  return a.sourceRevision === b.sourceRevision && a.dependencySetIdSha256 === b.dependencySetIdSha256
    && a.packageCount === b.packageCount;
}
function phaseFor(status: TaskRun["status"]): DependencyEntry["phase"] {
  if (status === "awaiting_permission") return "awaiting_permission";
  if (["created", "running"].includes(status)) return "running";
  return "failed";
}
