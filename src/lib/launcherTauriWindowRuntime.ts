import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export function createLauncherTauriWindowRuntime(invoke: () => unknown) {
  function hasTauriRuntime() {
    if (typeof window === "undefined") return false;
    const globalWindow = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      __TAURI_IPC__?: unknown;
    };
    return "__TAURI_INTERNALS__" in globalWindow || "__TAURI__" in globalWindow || "__TAURI_IPC__" in globalWindow;
  }

  function currentTauriWindowLabel() {
    if (typeof window === "undefined") return "";
    try { return getCurrentWebviewWindow().label; }
    catch { return ""; }
  }

  function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  async function waitForTauriRuntime(): Promise<boolean> {
    for (let index = 0; index < 25; index += 1) {
      if (hasTauriRuntime() && typeof invoke() === "function") return true;
      await sleep(80);
    }
    return hasTauriRuntime() && typeof invoke() === "function";
  }

  return { hasTauriRuntime, currentTauriWindowLabel, waitForTauriRuntime, sleep };
}
