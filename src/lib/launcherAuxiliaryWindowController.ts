import { invoke } from "@tauri-apps/api/core";

interface Ports {
  hasTauriRuntime: () => boolean;
  readClipboardText: () => Promise<string>;
  copyText: (text: string) => Promise<void>;
  clipboardText: () => string;
  setClipboardText: (text: string) => void;
  setStatus: (status: string) => void;
}

export function createLauncherAuxiliaryWindowController(ports: Ports) {
  async function openMainWindow(reportFailure: (error: unknown) => void) {
    if (!ports.hasTauriRuntime()) return;
    try { await invoke("show_main_window"); }
    catch (error) { reportFailure(error); }
  }

  function openMainFromFloatingBall() {
    return openMainWindow(error => console.warn("Failed to open main window from floating ball:", error));
  }

  async function openMainFromSuperPanel() {
    await openMainWindow(error => {
      ports.setStatus(String(error));
      console.warn("Failed to open main window from super panel:", error);
    });
    if (ports.hasTauriRuntime()) {
      try {
        await invoke("set_super_panel_visible", { visible: false });
      } catch (error) {
        console.warn("Failed to hide super panel after opening main window:", error);
      }
    }
  }

  async function refreshSuperPanelClipboard() {
    ports.setStatus("");
    try {
      const text = (await ports.readClipboardText()).trim();
      ports.setClipboardText(text);
      ports.setStatus(text ? "已读取剪贴板文本" : "剪贴板没有文本");
    } catch (error) {
      ports.setClipboardText("");
      ports.setStatus(String(error));
    }
  }

  async function copySuperPanelText() {
    const text = ports.clipboardText();
    if (!text.trim()) return;
    try {
      await ports.copyText(text);
      ports.setStatus("已复制");
    } catch (error) {
      ports.setStatus(String(error));
    }
  }

  return {
    openMainFromFloatingBall,
    openMainFromSuperPanel,
    refreshSuperPanelClipboard,
    copySuperPanelText,
  };
}
