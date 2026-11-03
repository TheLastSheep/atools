import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../src/lib/pinyinSearch.ts", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));

afterEach(() => {
  cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("returns Escape from installed-plugin detail to its list before the App returns home", async () => {
  const settings = { localAppSearch: false, autoPaste: "never", showRecentInSearch: false };
  const installed = {
    id: "codec", name: "codec", version: "1.0.0", enabled: true, source_kind: "imported",
    path: "/offline/plugins/codec", created_at: "2026-10-17", updated_at: "2026-10-17",
    manifest: { title: "工具 codec", main: "index.html", features: [{ code: "encode", label: "编码", explain: "编码文本" }] },
  };
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke, metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify(settings));
  mocks.invoke.mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "list_plugins") return [installed];
    if (["feature_catalog", "list_pending_agent_requests", "search_features", "search_local_apps"].includes(command)) return [];
    return undefined;
  });

  render(App, { backgroundServices: false });
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "插件管理" } });
  await fireEvent.click(await screen.findByRole("option", { name: /插件管理/ }));
  const entry = await screen.findByRole("button", { name: "查看 工具 codec 详情" });
  await fireEvent.click(entry);
  const heading = await screen.findByRole("heading", { name: "工具 codec" });
  await waitFor(() => expect(document.activeElement).toBe(heading));

  const webkitIme = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  Object.defineProperty(webkitIme, "keyCode", { value: 229 });
  heading.dispatchEvent(webkitIme);
  expect(screen.getByRole("region", { name: "插件详情" })).toBeTruthy();
  heading.dataset.atoolsComposing = "true";
  await fireEvent.keyDown(heading, { key: "Escape", isComposing: false });
  expect(screen.getByRole("region", { name: "插件详情" })).toBeTruthy();
  delete heading.dataset.atoolsComposing;

  await fireEvent.keyDown(heading, { key: "Escape" });

  await waitFor(() => expect(screen.getByRole("list", { name: "插件列表" })).toBeTruthy());
  expect(screen.queryByRole("region", { name: "插件详情" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看 工具 codec 详情" })));
});
