import { mount, tick } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
import type { InstalledPlugin } from "../../src/lib/types";

type Fixture = { token: string; pluginId: string };
let cspViolationCount = 0;
window.addEventListener("securitypolicyviolation", () => { cspViolationCount += 1; });
const cspMeta = () => document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? null;
const report = (token: string, value: Record<string, unknown>) =>
  invoke("native_inventory_logo_report", { token, report: value });

async function withTimeout<T>(promise: Promise<T>, durationMs: number, code: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(code)), durationMs);
    })]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

if (window === window.top) void (async () => {
  let token = "";
  let stage = "fixture";
  try {
    const fixture = await invoke<Fixture>("native_inventory_logo_fixture");
    token = fixture.token;
    let resolveListed!: (plugins: InstalledPlugin[]) => void;
    const loaded = new Promise<InstalledPlugin[]>(resolve => { resolveListed = resolve; });
    stage = "production-inventory";
    mount(PluginInventoryPanel, {
      target: document.getElementById("app")!,
      props: { confirm: async () => false, onpluginsloaded: (plugins: InstalledPlugin[]) => resolveListed(plugins) },
    });
    const plugins = await withTimeout(loaded, 15000, "inventory-load-timeout");
    await tick();
    const target = plugins.filter(plugin => plugin.id === fixture.pluginId);
    if (target.length !== 1) throw new Error("fixture-record-count");
    stage = "icon-element";
    const image = Array.from(document.querySelectorAll<HTMLImageElement>(".plugin-list img"))
      .find(candidate => candidate.closest("[data-plugin-id]")?.getAttribute("data-plugin-id") === fixture.pluginId);
    if (!image) throw new Error("production-icon-fallback");
    const assetUrlAllowed = /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)/i.test(image.currentSrc || image.src);
    stage = "native-image-decode";
    await withTimeout(image.decode(), 20000, "webview-image-decode-timeout");
    await report(token, {
      passed: true, pluginId: target[0].id, sourceKind: target[0].source_kind,
      inventoryLogoPath: target[0].inventory_logo_path ?? null,
      assetUrlAllowed, decodeResolved: true, complete: image.complete,
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      fallbackVisible: Boolean(image.closest(".plugin-row")?.querySelector(".monogram")),
      cspMeta: cspMeta(), cspViolationCount,
    });
  } catch (error) {
    if (token) await report(token, { passed: false, stage, errorCode: error instanceof Error ? error.message : "unknown-fixture-error", cspMeta: cspMeta(), cspViolationCount });
  }
})();
