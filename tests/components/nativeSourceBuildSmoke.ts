import { mount, unmount } from "svelte";
import { invoke as invokeRaw } from "@tauri-apps/api/core";
import Host from "/Users/harris/Desktop/atools/tests/components/SourceBuildNativeHost.svelte";
import "/Users/harris/Desktop/atools/src/styles/global.css";
import { runNativeSourceBuildScenario } from "./nativeSourceBuildScenario.ts";
import type { SourceBuildFixture, SourceBuildScenarioReport } from "./nativeSourceBuildScenario.ts";

type BootEvent = "main_entered" | "host_mounted" | "scenario_started" | "scenario_completed"
  | "frontend_catch_entered" | "unmount_started" | "unmount_completed" | "report_submitted";
type BootGlobals = Window & {
  __atoolsSourceBuildRunToken?: string;
  __atoolsSourceBuildRecord?: (event: BootEvent) => Promise<boolean>;
  __atoolsSourceBuildFlush?: () => Promise<boolean>;
  __atoolsSourceBuildScriptReady?: Promise<boolean>;
};
const boot = window as BootGlobals;

if (window === window.top) void (async () => {
  let app: ReturnType<typeof mount> | undefined;
  let report: Record<string, unknown> = { passed: false, failureCode: "frontend_not_started" };
  let reportAttempted = false;
  let realPackageProfile = false;
  let typescriptProfile = false;
  const runToken = boot.__atoolsSourceBuildRunToken;
  const settleWithin = <T>(operation: Promise<T>, milliseconds = 8000): Promise<T | undefined> =>
    new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), milliseconds);
      operation.then(value => { clearTimeout(timer); resolve(value); }, () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  const submitReport = async (failureBeforeTeardown = false) => {
    if (reportAttempted) return;
    reportAttempted = true;
    const record = boot.__atoolsSourceBuildRecord;
    if (!runToken || !record || !boot.__atoolsSourceBuildFlush) {
      report.passed = false;
      return;
    }
    try {
      if (failureBeforeTeardown) {
        if (await settleWithin(record("report_submitted")) !== true) report.passed = false;
        if (await settleWithin(boot.__atoolsSourceBuildFlush()) !== true) report.passed = false;
      } else {
        if (!(await record("report_submitted"))) report.passed = false;
        if (!(await boot.__atoolsSourceBuildFlush())) report.passed = false;
      }
      await invoke("native_source_build_report", { message: { runToken, report } });
    }
    catch { report.passed = false; }
  };
  try {
    if (!runToken || !/^[0-9a-f-]{36}$/.test(runToken) || !boot.__atoolsSourceBuildRecord || !boot.__atoolsSourceBuildScriptReady) {
      throw new Error("boot_diagnostic_unavailable");
    }
    const record = boot.__atoolsSourceBuildRecord;
    if (!(await boot.__atoolsSourceBuildScriptReady)) throw new Error("panel_load_diagnostic_rejected");
    if (!(await record("main_entered"))) throw new Error("boot_diagnostic_rejected");
    const fixture = await invoke<SourceBuildFixture>("native_source_build_fixture");
    realPackageProfile = fixture.profile === "application-uninstaller";
    typescriptProfile = fixture.typescriptBuild === true;
    if (fixture.runToken !== runToken) throw new Error("boot_token_mismatch");
    app = mount(Host, { target: document.getElementById("app")! });
    if (!(await record("host_mounted"))) throw new Error("boot_diagnostic_rejected");
    if (!(await record("scenario_started"))) throw new Error("boot_diagnostic_rejected");
    const scenario: SourceBuildScenarioReport = await runNativeSourceBuildScenario(fixture);
    report = typescriptProfile
      ? { passed: scenario.passed === true, checks: scenario.checks, buildPipelineEvidence: scenario.buildPipelineEvidence ?? {} }
      : {
          passed: scenario.passed,
          checks: scenario.checks,
          observations: scenario.observations,
          ...(scenario.failureCode !== undefined ? { failureCode: scenario.failureCode } : {}),
          ...(scenario.error !== undefined ? { error: scenario.error } : {}),
          ...(scenario.errorStack !== undefined ? { errorStack: scenario.errorStack } : {}),
          ...(scenario.bodyText !== undefined ? { bodyText: scenario.bodyText } : {}),
        };
    if (!(await record("scenario_completed"))) report.passed = false;
    if (report.passed !== true) {
      report = realPackageProfile
        ? { passed: false, failureCode: "scenario_failed", checks: report.checks ?? {} }
        : { passed: false, failureCode: "scenario_failed", checks: report.checks ?? {},
          ...(typescriptProfile ? { buildPipelineEvidence: report.buildPipelineEvidence ?? {} } : { observations: report.observations ?? {} }) };
    }
  } catch {
    report = { passed: false, failureCode: "frontend_boot_or_scenario_failed", checks: {}, observations: {} };
    if (boot.__atoolsSourceBuildRecord) {
      try { await boot.__atoolsSourceBuildRecord("frontend_catch_entered"); } catch { /* Fixed failure remains fail-closed. */ }
    }
  }
  finally {
    // Preserve a caught failure before any teardown await can withhold the only report.
    if (report.passed !== true) await submitReport(true);
    const record = boot.__atoolsSourceBuildRecord;
    if (record) {
      try { if (!(await record("unmount_started"))) report.passed = false; }
      catch { report.passed = false; }
    } else report.passed = false;
    if (app) {
      try { await unmount(app); }
      catch { report.passed = false; report.unmountFailed = true; }
    }
    if (record) {
      try { if (!(await record("unmount_completed"))) report.passed = false; }
      catch { report.passed = false; }
    } else report.passed = false;
    if (!reportAttempted) await submitReport();
  }
})();

function invoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("fixture_call_timeout")), 8000);
    invokeRaw<T>(name, args).then(value => { clearTimeout(timer); resolve(value); }, () => {
      clearTimeout(timer);
      reject(Error("fixture_call_failed"));
    });
  });
}
