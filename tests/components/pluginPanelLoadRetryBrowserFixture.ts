import { mount, unmount } from "svelte";
import PluginPanel from "../../src/components/PluginPanel.svelte";

declare global {
  interface Window {
    pluginPanelLoadRetryFixture?: {
      ready: boolean;
      readCount: number;
      errorCount: number;
      calls: string[];
      failPendingRead(): void;
      resolvePendingRead(): void;
      resetForFocusTakeover(): Promise<void>;
      dispose(): Promise<void>;
    };
  }
}

const calls: string[] = [];
let readCount = 0;
let errorCount = 0;
let failPending!: (error: Error) => void;
let resolvePending!: (bytes: number[]) => void;
let callbackId = 0;
const html = (body: string) => new TextEncoder().encode(`<!doctype html><html><head></head><body>${body}</body></html>`);

Object.assign(window, {
  __TAURI_INTERNALS__: {
    metadata: { currentWindow: { label: "main" } },
    invoke: async (command: string) => {
      calls.push(command);
      if (command === "plugin:fs|read_text_file") {
        readCount++;
        if (readCount === 1) throw new Error("Synthetic initial HTML failure");
        if (readCount === 2) return new Promise<number[]>((resolve, reject) => {
          resolvePending = resolve;
          failPending = reject;
        });
        return Array.from(html("<main>retry succeeded</main>"));
      }
      if (command === "plugin:event|listen") return ++callbackId;
      if (command === "plugin:event|unlisten") return undefined;
      if (["prepare_plugin_data", "prepare_plugin_paths", "prepare_plugin_display", "prepare_host_clipboard", "prepare_plugin_dialogs"].includes(command)) {
        return { unavailable: true, usage: "not_detected" };
      }
      return undefined;
    },
    transformCallback: () => ++callbackId,
    unregisterCallback: () => undefined,
    convertFileSrc: (path: string) => `asset://fixture/${encodeURIComponent(path)}`,
  },
});

function mountPanel() {
  return mount(PluginPanel, {
    target: document.getElementById("fixture-root")!,
    props: {
      action: {
        plugin_id: "browser-load-retry", plugin_name: "重试验收", feature_code: "retry",
        main_url: "index.html", plugin_path: "/synthetic/load-retry", expand_height: 420, payload: null,
      },
      onclose: () => undefined,
      onloaderror: () => { errorCount++; },
    },
  });
}

let app = mountPanel();

window.pluginPanelLoadRetryFixture = {
  get ready() { return Boolean(document.querySelector('[role="alert"]')) && readCount === 1; },
  get readCount() { return readCount; },
  get errorCount() { return errorCount; },
  get calls() { return [...calls]; },
  failPendingRead() { failPending(new Error("Synthetic retry HTML failure")); },
  resolvePendingRead() { resolvePending(Array.from(html("<main>retry succeeded after focus moved</main>"))); },
  async resetForFocusTakeover() {
    await unmount(app);
    document.getElementById("fixture-root")!.replaceChildren();
    calls.length = 0;
    readCount = 0;
    errorCount = 0;
    callbackId = 0;
    app = mountPanel();
  },
  dispose() { return unmount(app); },
};
