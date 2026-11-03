import { createLauncherBackgroundSurfaceBindings } from "./launcherBackgroundSurfaceBindings";
import type { PluginPanelMountExports, PluginPanelMountProps } from "./pluginPanelMount";
import type { FeatureAction } from "./types";

type Options = {
  activeAction: FeatureAction | null;
  enabled: boolean;
  promotedRunnerId: string | null;
  panelPropsForAction: (action: FeatureAction) => PluginPanelMountProps;
  onPluginPanelInstance: (instance: PluginPanelMountExports | null) => void;
  activePluginId: () => string | null;
  returnToSearch: () => void | Promise<void>;
};

/** Binds ordinary and persistent panel ownership to one primary-surface contract. */
export function createLauncherPluginPanelSurfaceBindings(options: Options) {
  return {
    pluginPanelProps: options.activeAction ? options.panelPropsForAction(options.activeAction) : null,
    ...createLauncherBackgroundSurfaceBindings(options),
  };
}
