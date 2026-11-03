import type { DesktopSmokeFilesActivation } from "./desktopSmokeFilesActivationContract";

export type { DesktopSmokeFilesActivation as DesktopSmokeDeepReadFilesActivation } from "./desktopSmokeFilesActivationContract";

type FileActivationOptions = {
  expectedPluginId: string;
  mediaContent: { kind: "files"; paths: string[] };
  throwOnError: true;
  isCancelled: () => boolean;
};

type LauncherFeatureActivator = (
  code: string,
  payload: null,
  options: FileActivationOptions,
) => Promise<number | null>;

type Ports = {
  desktopSmokeEnabled: () => boolean;
  activateFeature: LauncherFeatureActivator;
};

export function createDesktopSmokeDeepReadFilesActivationPort(ports: Ports) {
  let disposed = false;
  let published = false;
  let generation = 0;

  const activateFilesFeature = async (code: string, paths: readonly string[], expectedPluginId: string, runId?: string) => {
    if (disposed || !ports.desktopSmokeEnabled()) throw new Error("Desktop smoke activation scope is unavailable");
    if (runId !== undefined || code !== "deepread-import" || expectedPluginId !== "deepread" || paths.length !== 1
      || !/^\/private\/tmp\/atools-fixture-environment-[A-Za-z0-9_-]+\/home\/Downloads\/ATools-DeepRead-Reader-Fixture\.txt$/.test(paths[0])) {
      throw new Error("DeepRead smoke activation input is outside its fixed fixture scope");
    }
    const callGeneration = generation;
    const isCancelled = () => disposed || generation !== callGeneration || !ports.desktopSmokeEnabled();
    await ports.activateFeature(code, null, {
      expectedPluginId,
      mediaContent: { kind: "files", paths: [...paths] },
      throwOnError: true,
      isCancelled,
    });
    if (isCancelled()) throw new Error("Desktop smoke activation scope ended during feature activation");
  };

  return {
    publishReady(onReady: (activateFilesFeature: DesktopSmokeFilesActivation) => void): boolean {
      if (disposed || published || !ports.desktopSmokeEnabled()) return false;
      published = true;
      onReady(activateFilesFeature);
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
    },
  };
}
