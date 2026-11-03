import type { FeatureAction, PluginItem, PluginOutput } from "./types";
import { ignoreLauncherKeyboardEvent } from "./launcherKeyboard";
import { applyPluginSubInputMessage, type PluginSubInputState } from "./pluginSubInputState";
import { moveFeatureList, selectFeatureListCommand, type PluginFeatureIntent, type PluginFeatureList } from "./pluginFeatureExportsState";

export type OutputContextMenuState = { visible: boolean; x: number; y: number; itemIndex: number };
export type PluginPanelInteractionAccess = {
  action: () => FeatureAction;
  subInput: () => PluginSubInputState;
  setSubInput: (state: PluginSubInputState) => void;
  hasSubInput: () => boolean;
  featureList: () => PluginFeatureList;
  setFeatureList: (state: PluginFeatureList) => void;
  items: () => PluginItem[];
  setItems: (items: PluginItem[]) => void;
  selectedIndex: () => number;
  setSelectedIndex: (index: number) => void;
  outputMenu: () => OutputContextMenuState;
  setOutputMenu: (state: OutputContextMenuState) => void;
  iframeWindow: () => Window | null;
  post: (source: unknown, message: unknown) => boolean;
  writeText: (value: string) => Promise<void>;
  onOutput?: (output: PluginOutput) => void;
  onEscape?: () => void | Promise<void>;
  closePanel: () => void;
  permissionBlocked: () => boolean;
};

export function createPluginPanelInteractions(access: PluginPanelInteractionAccess) {
  function notifySubInputChange(text: string) {
    const state = access.subInput();
    access.post(access.iframeWindow(), { __ipc_subinput_change__: true, text, generation: state.generation, epoch: state.epoch });
  }
  function handleSubInputChange(text: string) {
    access.setSubInput({ ...access.subInput(), value: text });
    notifySubInputChange(text);
  }
  function featureListIntent(intent: PluginFeatureIntent) {
    const state = access.featureList();
    if (state.mode !== "list") return false;
    if (intent === "activate") {
      const command = selectFeatureListCommand(state);
      if (command) access.setFeatureList(access.post(access.iframeWindow(), command)
        ? { ...state, busy: true } : { ...state, busy: false, error: "插件页面已失效，请返回后重新打开" });
    } else access.setFeatureList(moveFeatureList(state, intent));
    return true;
  }
  function moveSubInputOutput(delta: -1 | 1) {
    if (featureListIntent(delta === -1 ? "previous" : "next")) return true;
    const items = access.items();
    if (items.length === 0) return false;
    closeOutputContextMenu();
    access.setSelectedIndex(Math.max(0, Math.min(access.selectedIndex() + delta, items.length - 1)));
    return true;
  }
  async function requestEscape() {
    if (access.permissionBlocked()) return;
    const state = access.subInput();
    if (access.hasSubInput() && state.value.length > 0) {
      handleSubInputChange("");
      access.setSubInput(applyPluginSubInputMessage(access.subInput(), { __ipc_subinput_focus__: true, action: "focus", epoch: state.epoch })!.state);
      return;
    }
    if (access.onEscape) await access.onEscape();
    else access.closePanel();
  }
  function handleItemClick(index: number) { closeOutputContextMenu(); void copyPluginOutputItem(index); }
  function copyPluginOutputItem(index: number) {
    const item = access.items()[index];
    if (!item?.data) return Promise.resolve(false);
    return access.writeText(item.data).then(() => {
      const copiedItem = { title: "已复制", description: item.data, data: item.data };
      access.setItems([copiedItem]); access.setSelectedIndex(0);
      access.onOutput?.({ items: [copiedItem], plugin_id: access.action().plugin_id, feature_code: access.action().feature_code });
      return true;
    }).catch(error => { console.warn("[PluginPanel] plugin output copy failed:", error); return false; });
  }
  function openOutputContextMenu(event: MouseEvent, index: number) {
    if (!access.items()[index]?.data) return;
    event.preventDefault(); access.setSelectedIndex(index);
    access.setOutputMenu({ visible: true, x: event.clientX, y: event.clientY, itemIndex: index });
  }
  function closeOutputContextMenu() {
    if (!access.outputMenu().visible) return;
    access.setOutputMenu({ visible: false, x: 0, y: 0, itemIndex: -1 });
  }
  function copyOutputContextMenuItem() {
    const index = access.outputMenu().itemIndex; closeOutputContextMenu(); void copyPluginOutputItem(index);
  }
  function handlePluginPanelKeydown(event: KeyboardEvent) {
    if (ignoreLauncherKeyboardEvent(event)) return;
    if (event.key === "Escape" && access.outputMenu().visible) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); closeOutputContextMenu();
    }
  }
  return { handleSubInputChange, featureListIntent, moveSubInputOutput, requestEscape, handleItemClick,
    copyPluginOutputItem, notifySubInputChange, openOutputContextMenu, closeOutputContextMenu, copyOutputContextMenuItem,
    handlePluginPanelKeydown };
}
