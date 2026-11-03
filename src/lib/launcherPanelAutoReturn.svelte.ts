import { autoBackToSearchDelayMs } from "./searchBehavior";
import type { FeatureAction } from "./types";
import type { ShellPanel } from "./uiState";
import type { AToolsSettings } from "./settings";

interface Ports {
  activePanel: () => ShellPanel;
  activePlugin: () => FeatureAction | null;
  settings: () => AToolsSettings;
  onPanelChange: (panel: ShellPanel) => Promise<void>;
}

/** Returns a panel to search after its configured idle delay, cancelling stale timers on state changes. */
export function useLauncherPanelAutoReturn(ports: Ports) {
  $effect(() => {
    const panel = ports.activePanel();
    const plugin = ports.activePlugin();
    const delay = autoBackToSearchDelayMs(ports.settings().autoBackToSearch);
    if (panel === "home" || plugin !== null || delay === null) return;

    const timer = setTimeout(() => {
      if (ports.activePlugin() === null && ports.activePanel() === panel) {
        void ports.onPanelChange("home");
      }
    }, delay);
    return () => clearTimeout(timer);
  });
}
