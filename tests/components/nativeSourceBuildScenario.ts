import { invoke as rawInvoke } from "@tauri-apps/api/core";
import type { TaskRun, PendingAgentToolRequest } from "/Users/harris/Desktop/atools/src/lib/types";
import { runNativeApplicationUninstallerScenario } from "./nativeApplicationUninstallerScenario.ts";

export type SourceBuildFixture = { successPath: string; cancelPath: string; invalidPath: string; pluginId: string; profile?: string; typescriptBuild?: boolean; runToken: string };
export type BuildPipelineEvidence = {
  success?: {
    stepKinds: Array<"typecheck" | "viteBuild">;
    runnerExitCode?: number;
    outputEntries?: number;
    outputBytes?: number;
  };
  invalidTypecheck?: {
    runnerFailureCode?: "SourceBuildProcessFailed";
    runnerExitCode?: number;
    outputIdentityMismatch: boolean;
    buildOutputAbsent: boolean;
    previousInstallationPreserved: boolean;
  };
};
export type SourceBuildScenarioReport = {
  passed: boolean;
  checks: Record<string, boolean>;
  observations: Record<string, unknown>;
  failureCode?: string;
  error?: string;
  errorStack?: string | null;
  bodyText?: string;
  buildPipelineEvidence?: BuildPipelineEvidence;
};
type Snapshot = {
  pluginVersion: string | null;
  installedHash: string | null;
  installedPackageReadiness: string | null;
  installedManifestMain: string | null;
  installedManifestAtPackageRoot: boolean;
  allTaskRunsTerminal: boolean;
};
const tool = "convert_ztools_plugin";
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
function invoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Native source-build observation timeout: " + name)), 8000);
    rawInvoke<T>(name, args).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
const safeInteger = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) ? Number(value) : undefined;

export async function runNativeSourceBuildScenario(fixture: SourceBuildFixture): Promise<SourceBuildScenarioReport> {
  const checks: Record<string, boolean> = {}, observations: Record<string, unknown> = {};
  const buildPipelineEvidence: BuildPipelineEvidence = {};
  const check = (value: unknown, name: string) => { if (!value) throw Error(name); checks[name] = true; };
  async function until<T>(read: () => T | Promise<T>, name: string): Promise<NonNullable<T>> {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await pause(); }
    throw Error(name);
  }
  const runs = () => invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
  const snapshot = () => invoke<Snapshot>("native_source_build_snapshot");
  function row(path: string) {
    return [...document.querySelectorAll<HTMLElement>(".candidate-path")].find(node => node.title === path)?.closest<HTMLElement>(".candidate-row");
  }
  function button(owner: Element, label: string) {
    return [...owner.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  }
  async function start(path: string) {
    const owner = await until(() => row(path), "Actual scanned source row missing");
    check(owner.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled, "Unbuilt sources stay out of direct-import checkboxes");
    const inspect = await until(() => {
      const node = button(owner, "检查可转换版本") ?? button(owner, "重新检查转换");
      return node && !node.disabled ? node : null;
    }, "Source inspection did not become actionable");
    check(inspect, "Source inspection requires a deliberate action"); inspect.click();
    const convert = await until(() => { const node = button(owner, "一键转换并安装"); return node && !node.disabled ? node : null; }, "Eligible source did not expose conversion");
    check(!convert.disabled, "Eligible source conversion is actionable");
    convert.click();
    const request = await until(async () => (await invoke<PendingAgentToolRequest[]>("list_pending_agent_requests"))
      .find(request => request.tool_name === tool && request.arguments && (request.arguments as Record<string, unknown>).sourcePath === path), "Exact conversion permission missing");
    check(request.client_id === "atools-ui" && !!request.run_id && [...request.scopes].sort().join(",") === "file_read,file_write,shell", "Actual approval binds the reviewed project and exact scopes");
    const dialog = await until(() => document.querySelector<HTMLElement>("[data-permission-dialog]"), "Production permission dialog missing");
    check(dialog.querySelector("h2")?.textContent === "转换并安装本地插件" && dialog.textContent?.includes(path), "Permission explains conversion and the exact project");
    return { owner, request, dialog };
  }
  async function terminal(id: string) {
    return until(async () => {
      const run = await invoke<TaskRun | null>("get_task_run", { id });
      if (!run) return null;
      check(run.id === id && run.capabilityId === tool && run.initiator?.clientId === "atools-ui", "Durable observations retain the original conversion identity");
      return ["succeeded", "failed", "cancelled", "partial"].includes(run.status) ? run : null;
    }, "Conversion did not reach a durable terminal state");
  }
  try {
    if (fixture.profile === "application-uninstaller") return await runNativeApplicationUninstallerScenario();
    const before = await snapshot(); observations.before = before;
    check(before.pluginVersion === "1.0.0" && !!before.installedHash, "Existing private baseline is installed before conversion");
    check(before.installedPackageReadiness === "ready" && before.installedManifestMain === "index.html"
      && before.installedManifestAtPackageRoot, "Baseline package resolves its root manifest and HTML entry");
    const denied = await start(fixture.successPath);
    const deny = button(denied.dialog, "拒绝"); check(deny, "Production deny control exists"); deny!.click();
    check((await terminal(denied.request.run_id!)).status === "cancelled", "Deny cancels the original durable task");
    check((await snapshot()).installedHash === before.installedHash, "Deny preserves the existing installation");
    await until(() => !document.querySelector("[data-permission-dialog]") && button(denied.owner, "重新检查转换"), "Denied UI did not become retryable");

    const success = await start(fixture.successPath);
    button(success.dialog, "允许一次")!.click();
    await until(async () => {
      const run = await invoke<TaskRun | null>("get_task_run", { id: success.request.run_id });
      return !!run && run.id === success.request.run_id && run.capabilityId === tool && run.status === "running";
    }, "Approved task did not run");
    await until(() => !document.querySelector("[data-permission-dialog]"), "Consumed approval modal blocks background progress");
    check((await snapshot()).installedHash === before.installedHash, "Running build leaves the existing installation usable");
    const succeeded = await terminal(success.request.run_id!); observations.success = succeeded;
    check(succeeded.status === "succeeded" && (succeeded.output as Record<string, unknown>)?.installed === true, "Real worker result is installed through the shared task pipeline");
    const build = (succeeded.output as Record<string, unknown>)?.build as Record<string, unknown> | undefined;
    const rewrite = build?.manifestRewrite as Record<string, unknown> | undefined;
    if (fixture.typescriptBuild === true) {
      const steps = (succeeded.output as Record<string, unknown>)?.buildSteps as Array<Record<string, unknown>> | undefined;
      const output = build?.output as Record<string, unknown> | undefined;
      const orderedSteps = Array.isArray(steps) && steps.length === 2
        && steps[0]?.kind === "typecheck" && steps[1]?.kind === "viteBuild";
      const completedBuild = build?.exitCode === 0 && Number.isSafeInteger(output?.entries) && Number(output?.entries) > 0
        && Number.isSafeInteger(output?.bytes) && Number(output?.bytes) > 0;
      const stepKinds: Array<"typecheck" | "viteBuild"> = orderedSteps ? ["typecheck", "viteBuild"] : [];
      const runnerExitCode = safeInteger(build?.exitCode);
      const outputEntries = safeInteger(output?.entries);
      const outputBytes = safeInteger(output?.bytes);
      buildPipelineEvidence.success = { stepKinds,
        ...(runnerExitCode !== undefined ? { runnerExitCode } : {}),
        ...(outputEntries !== undefined ? { outputEntries } : {}),
        ...(outputBytes !== undefined ? { outputBytes } : {}) };
      check(orderedSteps, "Actual conversion TaskRun retains the typecheck then Vite plan");
      check(completedBuild, "Actual compiler-and-Vite runner completed and published a nonempty output tree");
    }
    const beforeSha = rewrite?.beforeSha256, afterSha = rewrite?.afterSha256;
    const mappedFields = rewrite?.mappedFields;
    const rewriteObserved = typeof beforeSha === "string" && /^[0-9a-f]{64}$/.test(beforeSha)
      && typeof afterSha === "string" && /^[0-9a-f]{64}$/.test(afterSha) && beforeSha !== afterSha
      && Array.isArray(mappedFields) && mappedFields.length === 1 && mappedFields[0] === "main";
    check(rewriteObserved, "Build reports a changed, source-approved main-only manifest rewrite");
    observations.manifestRewrite = { beforeSha256: beforeSha, afterSha256: afterSha, mappedFields };
    await until(() => success.owner.textContent?.includes("转换并安装已完成"), "Actual panel did not show installed success");
    const installed = await snapshot(); observations.installed = installed;
    check(!!installed.installedHash && installed.installedHash !== before.installedHash, "Validated build transaction replaces the baseline artifact");
    check(installed.installedPackageReadiness === "ready" && installed.installedManifestMain === "index.html"
      && installed.installedManifestAtPackageRoot, "Imported package resolves to stable root index.html readiness without another inspect call");

    const invalid = await start(fixture.invalidPath);
    button(invalid.dialog, "允许一次")!.click();
    const failed = await terminal(invalid.request.run_id!); observations.invalid = failed;
    check(failed.status === "failed", "Invalid build fixture is durably failed");
    if (fixture.typescriptBuild === true) {
      const failure = failed.errors?.find(issue => issue.code === "source_build_runner_failed");
      const details = failure?.details as Record<string, unknown> | undefined;
      const processFailure = details?.runnerFailureCode === "SourceBuildProcessFailed"
        && Number.isSafeInteger(details.runnerExitCode) && Number(details.runnerExitCode) !== 0;
      const identityFailure = failed.errors?.some(issue => issue.message === "SourceBuildOutputIdentityMismatch") === true;
      const failedOutput = failed.output as Record<string, unknown> | null | undefined;
      const buildOutputAbsent = !failedOutput || (!Object.prototype.hasOwnProperty.call(failedOutput, "build") && !Object.prototype.hasOwnProperty.call(failedOutput, "buildSteps"));
      const previousInstallationPreserved = (await snapshot()).installedHash === installed.installedHash;
      const runnerExitCode = safeInteger(details?.runnerExitCode);
      buildPipelineEvidence.invalidTypecheck = {
        ...(details?.runnerFailureCode === "SourceBuildProcessFailed" ? { runnerFailureCode: "SourceBuildProcessFailed" as const } : {}),
        ...(runnerExitCode !== undefined ? { runnerExitCode } : {}),
        outputIdentityMismatch: identityFailure, buildOutputAbsent, previousInstallationPreserved };
      check(processFailure && !identityFailure && buildOutputAbsent,
        "Real nonzero runner process failure occurs before a build output reaches output-identity validation");
      check(previousInstallationPreserved, "TypeScript process failure preserves the previously committed installation");
    } else {
      check(failed.errors?.some(issue => issue.message === "SourceBuildOutputIdentityMismatch"),
        "Invalid fixture reaches the output identity validator instead of failing its build script");
      check((await snapshot()).installedHash === installed.installedHash, "Invalid output preserves the previously committed plugin");
    }
    await until(() => !document.querySelector("[data-permission-dialog]"), "Failed task permission did not close");

    const cancellation = await start(fixture.cancelPath);
    button(cancellation.dialog, "允许一次")!.click();
    await until(() => !document.querySelector("[data-permission-dialog]"), "Running conversion did not release permission modal");
    const cancel = await until(() => { const node = button(cancellation.owner, "取消转换"); return node && !node.disabled ? node : null; }, "Actual cancel control is unreachable");
    cancel.click();
    const cancelled = await terminal(cancellation.request.run_id!); observations.cancelled = cancelled;
    check(cancelled.status === "cancelled", "Cooperative cancellation becomes terminal only after the worker exits");
    check((await snapshot()).installedHash === installed.installedHash, "Cancelled build preserves committed installation");
    await until(async () => (await snapshot()).allTaskRunsTerminal, "Fixture left nonterminal tasks");
    const all = await runs(); observations.taskRunCount = all.length;
    check(all.filter(run => run.capabilityId === tool).length === 4, "Four attempts retain four distinct original task identities");
    observations.scope = "Real native components, permissions, TaskRuns, Vite and transaction; synthetic packages; programmatic DOM actions, no physical input or original-plugin usability claim";
    return { passed: true, checks, observations,
      ...(fixture.typescriptBuild === true ? { buildPipelineEvidence } : {}) };
  } catch {
    return { passed: false, checks, observations, failureCode: "scenario_failed",
      ...(fixture.typescriptBuild === true ? { buildPipelineEvidence } : {}) };
  }
}
