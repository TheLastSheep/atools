import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import type { LocalLaunchEntry } from "./localLaunch";
import { resolveLocalLaunchPath } from "./localLaunch";
import type { PastedItem } from "./pasteIntake";
import { pastedItemByCode } from "./pasteIntake";
import type { SearchResult } from "./types";
import { payloadFromTextQuickActionCode } from "./textQuickActions";

interface Ports {
  hasTauriRuntime: () => boolean;
  pastedItems: () => PastedItem[];
  refreshPermissionPrompt: () => Promise<void>;
  scheduleAutoClearSearch: () => void;
  focusSearch: () => void;
}

export function createLauncherExternalActionsController(ports: Ports) {
  async function callAgentToolFromUi(name: string, args: Record<string, unknown>, confirmed = false) {
    if (!ports.hasTauriRuntime()) {
      console.info("Agent tool preview:", name, args);
      return;
    }
    try {
      await invoke("call_agent_tool", { name, arguments: args, clientId: "atools-ui", confirmed });
      await ports.refreshPermissionPrompt();
    } catch (error) {
      console.warn("Agent tool call failed:", error);
    }
  }

  async function safeHomeDir() {
    try { return await homeDir(); } catch { return ""; }
  }

  async function openLocalLaunchEntry(entry: LocalLaunchEntry) {
    const resolvedPath = resolveLocalLaunchPath(entry.path, ports.hasTauriRuntime() ? await safeHomeDir() : "");
    if (!ports.hasTauriRuntime()) {
      console.info("Local launch preview:", resolvedPath);
      ports.scheduleAutoClearSearch();
      return;
    }
    try {
      await callAgentToolFromUi("open_or_reveal_path", { path: resolvedPath, reveal: false }, true);
      ports.scheduleAutoClearSearch();
    } catch (error) {
      console.warn("Failed to open local launch path:", error);
    }
  }

  async function openLocalAppPath(path: string) {
    if (!path) return;
    if (!ports.hasTauriRuntime()) {
      console.info("Local app preview:", path);
      ports.scheduleAutoClearSearch();
      return;
    }
    try {
      await callAgentToolFromUi("open_or_reveal_path", { path, reveal: false }, true);
      ports.scheduleAutoClearSearch();
    } catch (error) {
      console.warn("Failed to open local app:", error);
    }
  }

  async function openUrl(url: string) {
    if (ports.hasTauriRuntime()) {
      await callAgentToolFromUi("open_url", { url }, true);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copyText(text: string) {
    if (ports.hasTauriRuntime()) {
      await invoke("copy_text", { text });
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  async function activateTextQuickAction(item: SearchResult) {
    const payload = payloadFromTextQuickActionCode(item.code);
    if (!payload) return;
    if (payload.kind === "path-open" || payload.kind === "path-reveal") {
      await callAgentToolFromUi("open_or_reveal_path", {
        path: payload.output,
        reveal: payload.kind === "path-reveal",
      });
    } else {
      await copyText(payload.output);
    }
    ports.scheduleAutoClearSearch();
    ports.focusSearch();
  }

  async function activatePastedResult(result: SearchResult) {
    const item = pastedItemByCode(result.code, ports.pastedItems());
    if (!item) return;
    if (!item.path) {
      console.info("Pasted item has no local path; save it first before running local tools.", item);
      ports.focusSearch();
      return;
    }

    if (result.code.startsWith("paste:ocr:")) {
      await callAgentToolFromUi("ocr_image", { path: item.path });
    } else if (result.code.startsWith("paste:compress:")) {
      await callAgentToolFromUi("compress_images", { paths: [item.path] });
    } else if (result.code.startsWith("paste:open:")) {
      await callAgentToolFromUi("open_or_reveal_path", { path: item.path, reveal: false });
    } else if (result.code.startsWith("paste:reveal:")) {
      await callAgentToolFromUi("open_or_reveal_path", { path: item.path, reveal: true });
    }
    ports.scheduleAutoClearSearch();
    ports.focusSearch();
  }

  return {
    callAgentToolFromUi,
    openLocalLaunchEntry,
    openLocalAppPath,
    openUrl,
    copyText,
    activateTextQuickAction,
    activatePastedResult,
  };
}
