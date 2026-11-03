import { invoke as rawInvoke } from "@tauri-apps/api/core";
import type { TaskRun, PendingAgentToolRequest } from "../../src/lib/types";
import { recordSourceBuildScenarioEvent } from "./nativeSourceBuildScenarioDiagnostics.ts";

type Fixture = { successPath: string; pluginId: string; expectedVersion: string; profile: string };
type Snapshot = { pluginVersion: string | null; installedHash: string | null; allTaskRunsTerminal: boolean; pendingRequestCount: number };
const tool = "convert_ztools_plugin";
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
function matchesExpectedBuildSteps(value: unknown): boolean {
  const expected: Array<Record<string, unknown>> = [
    { kind: "typecheck" }, { kind: "nodeTests", files: 4 }, { kind: "viteBuild" },
    { kind: "packageScript" }, { kind: "packageScript" },
  ];
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return false;
    const actual = step as Record<string, unknown>, wanted = expected[index];
    if (Object.keys(actual).sort().join(",") !== Object.keys(wanted).sort().join(",")) return false;
    return actual.kind === wanted.kind && (wanted.kind !== "nodeTests" || actual.files === wanted.files);
  });
}
function invoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Real-package source-build observation timeout: " + name)), 12000);
    rawInvoke<T>(name, args).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function runNativeApplicationUninstallerScenario() {
  const checks: Record<string, boolean> = {}, observations: Record<string, unknown> = {};
  const check = (value: unknown, name: string) => { if (!value) throw Error(name); checks[name] = true; };
  async function until<T>(read: () => T | Promise<T>, name: string, timeout = 120000): Promise<NonNullable<T>> {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await pause(); }
    throw Error(name);
  }
  const snapshot = () => invoke<Snapshot>("native_source_build_snapshot");
  function row(path: string) {
    return [...document.querySelectorAll<HTMLElement>(".candidate-path")].find(node => node.title === path)?.closest<HTMLElement>(".candidate-row");
  }
  function button(owner: Element, label: string) {
    return [...owner.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  }
  try {
    await recordSourceBuildScenarioEvent("scenario_entered");
    const fixture = await invoke<Fixture>("native_source_build_fixture");
    await recordSourceBuildScenarioEvent("fixture_received");
    check(fixture.profile === "application-uninstaller" && fixture.pluginId === "application-uninstaller"
      && fixture.expectedVersion === "0.1.0", "The dedicated native profile retains the original source identity");
    const before = await snapshot(); observations.before = before;
    await recordSourceBuildScenarioEvent("initial_snapshot_received");
    check(before.pluginVersion === null && before.installedHash === null,
      "A fresh real-plugin identity starts uninstalled rather than seeding source-only files as a package");
    await until(() => document.querySelector<HTMLElement>(".candidate-row"), "Source scan did not render any row");
    await recordSourceBuildScenarioEvent("scan_ready");
    const owner = await until(() => row(fixture.successPath), "Pinned application-uninstaller source row missing");
    await recordSourceBuildScenarioEvent("row_found");
    check(owner.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled,
      "Unbuilt source remains outside direct-import checkboxes");
    const inspect = await until(() => {
      const node = button(owner, "检查可转换版本") ?? button(owner, "重新检查转换");
      return node && !node.disabled ? node : null;
    }, "Real source inspection did not become actionable");
    await recordSourceBuildScenarioEvent("inspection_actionable");
    inspect.click();
    await recordSourceBuildScenarioEvent("inspection_clicked");
    const convert = await until(() => {
      const node = button(owner, "一键转换并安装"); return node && !node.disabled ? node : null;
    }, "Pinned real source did not become eligible");
    await recordSourceBuildScenarioEvent("inspection_completed");
    const labels = [...owner.querySelectorAll<HTMLElement>(".build-steps li")].map(node => node.textContent?.trim());
    check(JSON.stringify(labels) === JSON.stringify([
      "类型检查", "Node 测试（4 个文件）", "Vite 打包", "本地项目构建脚本", "本地项目构建脚本",
    ]), "Production UI displays all real package build steps in their planned order");
    convert.click();
    await recordSourceBuildScenarioEvent("conversion_clicked");
    const request = await until(async () => (await invoke<PendingAgentToolRequest[]>("list_pending_agent_requests"))
      .find(item => item.tool_name === tool && (item.arguments as Record<string, unknown> | undefined)?.sourcePath === fixture.successPath),
    "Exact real-source conversion permission missing");
    const expectedRevision = (request.arguments as Record<string, unknown>).expectedRevision;
    await recordSourceBuildScenarioEvent("permission_request_observed");
    check(request.client_id === "atools-ui" && !!request.run_id && typeof expectedRevision === "string"
      && /^[a-f0-9]{64}$/.test(expectedRevision)
      && [...request.scopes].sort().join(",") === "file_read,file_write,shell",
    "Permission binds the exact reviewed source revision, UI client, and existing scopes");
    const dialog = await until(() => document.querySelector<HTMLElement>("[data-permission-dialog]"), "Production permission dialog missing");
    check(dialog.querySelector("h2")?.textContent === "转换并安装本地插件"
      && dialog.textContent?.includes(fixture.successPath), "Permission identifies the actual package path");
    button(dialog, "允许一次")!.click();
    await recordSourceBuildScenarioEvent("permission_approval_clicked");
    const terminal = await until(async () => {
      const run = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
      if (!run) return null;
      const input = run.input && typeof run.input === "object" ? run.input as Record<string, unknown> : {};
      check(run.id === request.run_id && run.capabilityId === tool && run.initiator?.clientId === "atools-ui"
        && input.sourcePath === fixture.successPath && input.expectedRevision === expectedRevision,
      "Durable TaskRun retains the exact authorized source and revision");
      return ["succeeded", "failed", "cancelled", "partial"].includes(run.status) ? run : null;
    }, "Real source conversion did not reach a durable terminal state");
    await recordSourceBuildScenarioEvent("task_run_terminal_observed");
    observations.taskRun = terminal;
    check(terminal.status === "succeeded", "Unmodified local source package completed the production conversion pipeline");
    const output = terminal.output as Record<string, unknown>;
    check(output?.installed === true && output.pluginId === fixture.pluginId
      && output.version === fixture.expectedVersion && output.sourceRevision === expectedRevision,
    "TaskRun output confirms the real ID, version, installation, and reviewed source revision");
    check(matchesExpectedBuildSteps(output.buildSteps), "TaskRun records the complete typed build plan without skipping original package steps");
    const plugins = await invoke<Array<Record<string, unknown>>>("list_plugins");
    const installed = plugins.find(plugin => plugin.id === fixture.pluginId);
    check(installed?.version === fixture.expectedVersion, "Actual installed plugin inventory contains the package identity");
    await recordSourceBuildScenarioEvent("installed_inventory_verified");
    const after = await snapshot(); observations.after = after;
    await recordSourceBuildScenarioEvent("final_snapshot_received");
    check(after.pluginVersion === fixture.expectedVersion && typeof after.installedHash === "string"
      && after.installedHash.length === 64 && after.installedHash !== before.installedHash,
    "Fresh real identity has a DB plus complete installed-tree fingerprint after import");
    await until(() => !document.querySelector("[data-permission-dialog]"), "Permission dialog remained after terminal success");
    check(after.allTaskRunsTerminal && after.pendingRequestCount === 0, "Real-profile task and permission state are terminal");
    observations.scope = "One untracked local complete package; real production panel/inspection/permission/TaskRun/conversion/import; programmatic UI; no upstream denominator or broader plugin-usability claim";
    await recordSourceBuildScenarioEvent("scenario_completed");
    return { passed: true, checks, observations };
  } catch (error) {
    try { await recordSourceBuildScenarioEvent("scenario_catch_entered"); } catch { /* The first missing milestone remains diagnostic evidence. */ }
    return { passed: false, checks, observations, error: String(error instanceof Error ? error.message : error),
      errorStack: error instanceof Error ? error.stack : null, bodyText: document.body.innerText.slice(0, 5000) };
  }
}
