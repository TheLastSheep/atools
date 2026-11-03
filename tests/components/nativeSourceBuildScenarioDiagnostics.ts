import { invoke as invokeRaw } from "@tauri-apps/api/core";

export type SourceBuildScenarioEvent =
  | "scenario_entered"
  | "fixture_received"
  | "initial_snapshot_received"
  | "scan_ready"
  | "row_found"
  | "inspection_actionable"
  | "inspection_clicked"
  | "inspection_completed"
  | "conversion_clicked"
  | "permission_request_observed"
  | "permission_approval_clicked"
  | "task_run_terminal_observed"
  | "installed_inventory_verified"
  | "final_snapshot_received"
  | "scenario_completed"
  | "scenario_catch_entered";

type ScenarioDiagnosticWindow = Window & { __atoolsSourceBuildRunToken?: string };

let eventCount = 0;
const EVENT_LIMIT = 24;

export async function recordSourceBuildScenarioEvent(event: SourceBuildScenarioEvent): Promise<void> {
  const token = (window as ScenarioDiagnosticWindow).__atoolsSourceBuildRunToken;
  if (!token || !/^[0-9a-f-]{36}$/.test(token) || eventCount >= EVENT_LIMIT) {
    throw new Error("source_build_scenario_diagnostic_unavailable");
  }
  eventCount += 1;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("source_build_scenario_diagnostic_timeout")), 8000);
      try {
        void invokeRaw("native_source_build_scenario_diagnostic", { message: { runToken: token, event } })
          .then(() => { clearTimeout(timer); resolve(); }, () => {
            clearTimeout(timer);
            reject(new Error("source_build_scenario_diagnostic_rejected"));
          });
      } catch {
        clearTimeout(timer);
        reject(new Error("source_build_scenario_diagnostic_rejected"));
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "source_build_scenario_diagnostic_timeout") throw error;
    throw new Error("source_build_scenario_diagnostic_rejected");
  }
}
