import type { PluginPanelMountExports, PluginPanelMountProps } from "./pluginPanelMount";
import type { FeatureAction } from "./types";

type Options = {
  enabled: boolean;
  promotedRunnerId: string | null;
  panelPropsForAction: (action: FeatureAction) => PluginPanelMountProps;
  onPluginPanelInstance: (instance: PluginPanelMountExports | null) => void;
  activePluginId: () => string | null;
  returnToSearch: () => void | Promise<void>;
};

/** Keeps launcher ownership and background-host callbacks together at the App boundary. */
export function createLauncherBackgroundSurfaceBindings(options: Options) {
  return {
    backgroundEnabled: options.enabled,
    backgroundPanelPropsForAction: options.panelPropsForAction,
    onBackgroundPluginPanelInstance: options.onPluginPanelInstance,
    onBackgroundInvalidated(pluginId: string | null) {
      const activePluginId = options.activePluginId();
      if (activePluginId && (pluginId === null || activePluginId === pluginId)) void options.returnToSearch();
    },
    hidePluginPanel: Boolean(options.promotedRunnerId),
    mainPushPromotedId: options.promotedRunnerId,
    onPluginPanelInstance: options.onPluginPanelInstance,
  };
}
