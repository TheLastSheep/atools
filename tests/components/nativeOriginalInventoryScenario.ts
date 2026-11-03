import type { InstalledPlugin } from "../../src/lib/types";
import { invoke, launcherInput, runtimeDrained, verifyPublishedFrameIsolation } from "./nativePublishedPluginCommon";
import type { PublishedFrameIsolation, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";

/** One unchanged original also exercises the ordinary installed-plugin entry on real Wry/IPC. */
export async function verifyOriginalInstalledEntry(context: PublishedScenarioContext): Promise<RuntimeState> {
  const { profile, check, until, probe, observations } = context;
  const nativeRecord = (await invoke<InstalledPlugin[]>("list_plugins")).find(plugin => plugin.id === profile.id);
  check(nativeRecord?.source_kind === "imported" && nativeRecord.enabled,
    "Native inventory classifies the actual installed original under the isolated managed plugin root");
  const management = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".capability-rail button")]
    .find(button => button.textContent?.trim() === "插件管理"), "Home installed-plugin entry missing");
  management.click();
  const input = await until(() => document.querySelector<HTMLInputElement>('.inventory input[aria-label="筛选已安装插件"]'),
    "Actual native installed inventory did not mount");
  input.value = profile.title;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const details = await until(() => [...document.querySelectorAll<HTMLButtonElement>("[data-plugin-detail-id]")]
    .find(button => button.dataset.pluginDetailId === profile.id), "Original is missing from native installed inventory");
  details.click();
  await until(() => document.querySelector(".plugin-detail h3") === document.activeElement, "Native plugin details did not receive focus");
  const feature = await until(() => [...document.querySelectorAll<HTMLButtonElement>(".plugin-detail button[data-feature-code]")]
    .find(button => button.dataset.featureCode === profile.featureCode && !button.disabled), "Exact original feature is not openable from native details");
  feature.click();
  const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),
    "Installed-plugin feature did not enter the actual production PluginPanel");
  const state = await until(async () => {
    try { return await probe<PublishedFrameIsolation>("state"); }
    catch (error) { if (String(error).includes("Frame probe timeout")) return null; throw error; }
  }, "Original did not initialize after opening from installed details");
  verifyPublishedFrameIsolation(frame, state, check);
  check(state.parentDocumentAccessBlocked && state.tauriInternalsType === "undefined",
    "The original reopened from installed details retains the production opaque sandbox");
  observations.installedInventoryEntry = {
    sourceKind: nativeRecord?.source_kind,
    pluginId: profile.id,
    featureCode: profile.featureCode,
    detailFocusedBeforeOpen: true,
    originalReopened: true,
    scope: "Actual Home > installed inventory > exact feature > App activation > original iframe; no OS chooser or synthetic activation",
  };
  const back = document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]');
  check(back, "Installed-entry original has the actual return-to-search action");
  back!.click();
  await until(() => !document.querySelector(".plugin-panel") && document.activeElement === launcherInput(),
    "Closing installed-entry original did not return focus to launcher");
  return until(async () => {
    const runtime = await invoke<RuntimeState>("native_published_runtime_state");
    return runtimeDrained(runtime) ? runtime : null;
  }, "Installed-entry original did not drain all owned runtime resources");
}
