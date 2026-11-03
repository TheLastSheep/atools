import { unsupported } from "./errors";
import type { ZToolsRendererTransport } from "./types";

const WINDOW_EVENTS = new Set(["tauri://focus", "atools://renderer-context-menu"]);
const MAIN_WEBVIEW_EVENTS = new Set([
  "renderer-main-file-drop",
  "atools://renderer-app-state",
  "atools://renderer-app-launched",
  "atools://renderer-apps-changed",
  "atools://renderer-plugins-changed",
  "atools://renderer-settings-view",
  "atools://renderer-general-settings",
  "atools://renderer-command-aliases",
  "atools://renderer-disabled-commands",
  "atools://renderer-local-shortcuts",
]);

/** Route notifications to the native surface that emits them; never subscribe to the app-wide bus. */
export function createTauriTransport(): ZToolsRendererTransport {
  return {
    async invoke(command, args) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke(command, args);
    },
    async listen(event, handler) {
      if (!WINDOW_EVENTS.has(event) && !MAIN_WEBVIEW_EVENTS.has(event)) {
        throw unsupported(`listen(${event})`);
      }
      const { listen } = await import("@tauri-apps/api/event");
      return listen(event, (message) => handler(event === "tauri://focus" ? undefined : message.payload), {
        target: { kind: MAIN_WEBVIEW_EVENTS.has(event) ? "Webview" : "Window", label: "main" },
      });
    },
  };
}
