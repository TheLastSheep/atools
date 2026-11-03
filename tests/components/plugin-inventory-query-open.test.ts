import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
import { PLUGIN_OPEN_REQUESTED_EVENT } from "../../src/lib/pluginOpen";
import type { InstalledPlugin } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ available: vi.fn(), list: vi.fn(), toggle: vi.fn(), authorize: vi.fn(), inventoryPlugins: undefined as unknown[] | undefined }));
vi.mock("../../src/lib/pluginInventoryServices", () => ({ pluginInventoryServices: (confirm: unknown) => ({
  available: mocks.available, listPlugins: mocks.list, chooseDirectory: vi.fn(), installDirectory: vi.fn(),
  updateDirectory: vi.fn(), togglePlugin: mocks.toggle, authorizePlugin: mocks.authorize,
  uninstallPlugin: vi.fn(), revealPath: vi.fn(), confirm,
}) }));
vi.mock("../../src/lib/pluginInventory", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, pluginInventory: (plugins: unknown[], options: unknown) => {
    mocks.inventoryPlugins = plugins;
    return actual.pluginInventory(plugins, options);
  } };
});

function plugin(enabled = true, features = [
  { code: "fixture-first", label: "Default action", explain: "The default explanation" },
  { code: "fixture-later", label: "Later unique label", explain: "Later unique explanation" },
]): InstalledPlugin {
  return { id: "fixture-plugin", name: "fixture-name", version: "1.0.0", enabled, source_kind: "imported",
    path: "/fixture/plugin", created_at: "2026-10-01", updated_at: "2026-10-02",
    manifest: { title: "Fixture Toolbox", description: "offline metadata", features } };
}

let installed: InstalledPlugin[];
const confirm = vi.fn(async () => true);
beforeEach(() => {
  mocks.available.mockReset(); mocks.list.mockReset(); mocks.toggle.mockReset(); mocks.authorize.mockReset();
  mocks.inventoryPlugins = undefined; confirm.mockReset(); confirm.mockResolvedValue(true);
  installed = [plugin()]; mocks.available.mockReturnValue(true);
  mocks.list.mockImplementation(async () => structuredClone(installed));
  mocks.authorize.mockImplementation(async (id: string) => {
    installed = installed.map(item => item.id === id ? { ...item, enabled: true } : item);
    return structuredClone(installed[0]);
  });
  mocks.toggle.mockImplementation(async (id: string, enabled: boolean) => {
    installed = installed.map(item => item.id === id ? { ...item, enabled } : item);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); });

async function openEventFor(query: string) {
  const requests: CustomEvent[] = [];
  const listener = (event: Event) => {
    event.preventDefault(); requests.push(event as CustomEvent);
    (event as CustomEvent).detail.respond({ status: "committed" });
  };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener);
  const view = render(PluginInventoryPanel, { confirm, query });
  await screen.findByRole("button", { name: "查看 Fixture Toolbox 详情" });
  return { view, requests, dispose: () => window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener) };
}

it.each(["fixture-later", "Later unique label", "Later unique explanation"])(
  "opens exactly the later feature selected by query %s",
  async query => {
    const event = await openEventFor(query);
    try {
      const button = await screen.findByRole("button", { name: "打开 Fixture Toolbox 的功能：Later unique label" });
      expect(button.getAttribute("data-feature-code")).toBe("fixture-later");
      await fireEvent.click(button);
      expect(event.requests).toHaveLength(1);
      expect(event.requests[0].detail).toMatchObject({ pluginId: "fixture-plugin", code: "fixture-later" });
    } finally { event.dispose(); event.view.unmount(); }
  },
);

it.each([
  ["", "fixture-first"],
  ["Fixture Toolbox", "fixture-first"],
  ["Later unique label", "fixture-first"],
])("keeps default open behavior for a generic %s query", async (query, expectedCode) => {
  const candidate = plugin(true, query === "Later unique label" ? [
    { code: "fixture-first", label: "Later unique label", explain: "" },
    { code: "fixture-later", label: "Later unique label two", explain: "" },
  ] : undefined);
  installed = [candidate];
  const event = await openEventFor(query);
  try {
    const button = await screen.findByRole("button", { name: "打开 Fixture Toolbox" });
    expect(button.hasAttribute("data-feature-code")).toBe(false);
    await fireEvent.click(button);
    expect(event.requests).toHaveLength(1);
    expect(event.requests[0].detail).toMatchObject({ pluginId: "fixture-plugin", code: expectedCode });
  } finally { event.dispose(); event.view.unmount(); }
});

it("requires a fresh enabled catalogue before opening a disabled unique target", async () => {
  installed = [plugin(false)];
  const event = await openEventFor("Later unique label");
  try {
    expect(await screen.findByRole("button", { name: "授权启用 Fixture Toolbox" })).toBeTruthy();
    expect(screen.getByText("启用后可打开「Later unique label」")).toBeTruthy();
    expect(event.requests).toHaveLength(0);
    await fireEvent.click(screen.getByRole("button", { name: "授权启用 Fixture Toolbox" }));
    const open = await screen.findByRole("button", { name: "打开 Fixture Toolbox 的功能：Later unique label" });
    expect(event.requests).toHaveLength(0);
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(open);
    expect(event.requests).toHaveLength(1);
    expect(event.requests[0].detail).toMatchObject({ code: "fixture-later" });
  } finally { event.dispose(); event.view.unmount(); }
});

it("rejects a still-connected target button when its fresh manifest gains a duplicate code", async () => {
  installed = [plugin(true, [
    { code: "target-code-A", label: "needle target", explain: "" },
    { code: "fixture-first", label: "Default action", explain: "" },
  ])];
  const event = await openEventFor("needle");
  try {
    const oldTargetButton = await screen.findByRole("button", { name: "打开 Fixture Toolbox 的功能：needle target" });
    const liveCatalogue = mocks.inventoryPlugins?.[0] as InstalledPlugin | undefined;
    expect(liveCatalogue).toBeTruthy();
    liveCatalogue!.manifest.features!.push({ code: "target-code-A", label: "duplicate without the query", explain: "" });
    expect(oldTargetButton.isConnected).toBe(true);
    await fireEvent.click(oldTargetButton);
    expect(event.requests).toHaveLength(0);
    expect(oldTargetButton.isConnected).toBe(true);
  } finally { event.dispose(); event.view.unmount(); }
});

it("rejects the detached target after refresh removes the last query match", async () => {
  installed = [plugin()];
  const event = await openEventFor("Later unique label");
  try {
    const oldButton = await screen.findByRole("button", { name: "打开 Fixture Toolbox 的功能：Later unique label" });
    installed = [plugin(true, [{ code: "fixture-first", label: "Default action", explain: "" }])];
    await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /打开 Fixture Toolbox/ })).toBeNull());
    oldButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(event.requests).toHaveLength(0);
  } finally { event.dispose(); event.view.unmount(); }
});

it("keeps the new generic action on the default path after the query changes", async () => {
  const event = await openEventFor("Later unique label");
  try {
    const input = screen.getByRole("textbox", { name: "筛选已安装插件" });
    input.focus();
    await fireEvent.input(input, { target: { value: "Fixture Toolbox" } });
    const button = await screen.findByRole("button", { name: "打开 Fixture Toolbox" });
    expect(document.activeElement).toBe(input);
    await fireEvent.click(button);
    expect(event.requests).toHaveLength(1);
    expect(event.requests[0].detail).toMatchObject({ pluginId: "fixture-plugin", code: "fixture-first" });
  } finally { event.dispose(); event.view.unmount(); }
});

it("does not allow a refreshed row that no longer matches the query to open", async () => {
  installed = [plugin()];
  const event = await openEventFor("Later unique label");
  try {
    const oldButton = await screen.findByRole("button", { name: "打开 Fixture Toolbox 的功能：Later unique label" });
    installed = [plugin(true, [{ code: "fixture-first", label: "Default action", explain: "" }])];
    await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /打开 Fixture Toolbox/ })).toBeNull());
    oldButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(event.requests).toHaveLength(0);
  } finally { event.dispose(); event.view.unmount(); }
});
