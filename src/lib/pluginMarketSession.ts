import { listen } from "@tauri-apps/api/event";
import { PluginMarketController, type PluginMarketDependencies } from "./pluginMarketController";
import type { PluginMarketProgress } from "./pluginMarketView";

// One renderer session survives settings/launcher navigation. It starts lazily on the
// first market visit and never polls or starts work without an explicit action.
let session: PluginMarketController | undefined;
let progressConnected = false;
let progressGeneration = 0;
let stopProgress: (() => void) | undefined;
let runtimeAvailable = false;
const owners = new Set<symbol>();

function syncProgress(controller: PluginMarketController) {
  const wanted = runtimeAvailable && (owners.size > 0 || Boolean(controller.state.pendingId));
  if (!wanted) {
    progressGeneration++;
    progressConnected = false;
    stopProgress?.(); stopProgress = undefined;
    controller.clearIdleCache();
  } else if (!progressConnected) {
    progressConnected = true;
    const generation = ++progressGeneration;
    void listen<PluginMarketProgress>("plugin-market-progress", event => controller.handleProgress(event.payload))
      .then(stop => { if (generation !== progressGeneration) stop(); else stopProgress = stop; })
      .catch(() => { if (generation === progressGeneration) progressConnected = false; });
  }
}

export function acquirePluginMarketSession(dependencies: PluginMarketDependencies) {
  if (!session) {
    session = new PluginMarketController(dependencies);
    const controller = session;
    controller.subscribe(() => syncProgress(controller));
  }
  const controller = session;
  const owner = Symbol("market-view");
  owners.add(owner);
  runtimeAvailable = dependencies.hasRuntime();
  const disconnect = controller.connect(dependencies);
  syncProgress(controller);
  return { controller, release: () => {
    owners.delete(owner);
    controller.leave(); disconnect(); syncProgress(controller);
  } };
}
