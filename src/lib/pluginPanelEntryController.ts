import type { FeatureAction, PluginItem } from "./types";
import type { PluginSubInputState } from "./pluginSubInputState";
import { emptyPluginSubInput } from "./pluginSubInputState";
import type { PluginFeatureList } from "./pluginFeatureExportsState";

type Ports = {
  subInput: () => PluginSubInputState; setSubInput: (state: PluginSubInputState) => void;
  dynamicFeatures: () => Array<{ code: string; label: string; explain: string }>; setDynamicFeatures: (items: Array<{ code: string; label: string; explain: string }>) => void;
  registeredTools: () => string[]; setRegisteredTools: (items: string[]) => void;
  setRequestedHeight: (height: number) => void; setOutDispatched: (value: boolean) => void; setDetachDispatched: (value: boolean) => void;
  clearContextMenu: () => void; setLastBrowserWindowMessage: (value: unknown) => void;
  setProbeResult: (value: unknown) => void; clearPermissionRequests: () => void;
  setApprovedPermissions: (value: string[]) => void; setPersistentPermissions: (value: string[]) => void;
  loadPersistentPermissions: (pluginId: string) => string[];
  setPluginItems: (items: PluginItem[]) => void; setSelectedIndex: (index: number) => void;
  setFeatureList: (value: PluginFeatureList) => void; emptyFeatureList: (generation: number) => PluginFeatureList;
  generation: () => number;
};

/** Resets per-entry UI state without revoking the long-lived document or Node owner. */
export function createPluginPanelEntryController(ports: Ports) {
  let owner = "";
  function reset(action: FeatureAction, force: boolean) {
    const nextOwner = `${action.plugin_id}\u0000${action.feature_code}`;
    if (!force && owner === nextOwner) return false;
    owner = nextOwner;
    const input = ports.subInput();
    // Keep both the epoch and sequence stable; the document's next bridge frame
    // may already be waiting with the following sequence number.
    ports.setSubInput(emptyPluginSubInput(input.sequence, 0, input.epoch));
    ports.setDynamicFeatures([]); ports.setRegisteredTools([]); ports.setRequestedHeight(0);
    ports.setOutDispatched(false); ports.setDetachDispatched(false); ports.clearContextMenu();
    ports.setLastBrowserWindowMessage(null); ports.setProbeResult(null); ports.clearPermissionRequests();
    ports.setApprovedPermissions([]); ports.setPersistentPermissions(ports.loadPersistentPermissions(action.plugin_id));
    ports.setPluginItems([]); ports.setSelectedIndex(0); ports.setFeatureList(ports.emptyFeatureList(ports.generation()));
    return true;
  }
  return { observe: (action: FeatureAction) => reset(action, false), activate: (action: FeatureAction) => reset(action, true) };
}
