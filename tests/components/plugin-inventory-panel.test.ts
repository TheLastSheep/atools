import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
import PluginInventoryDetail from "../../src/components/PluginInventoryDetail.svelte";
import { pluginInventory } from "../../src/lib/pluginInventory";
import { PLUGIN_OPEN_REQUESTED_EVENT } from "../../src/lib/pluginOpen";
import { grantPluginRuntimePermission, pluginRuntimePermissionGrantList } from "../../src/lib/pluginRuntimePermissions";
import type { InstalledPlugin } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ available: vi.fn(), list: vi.fn(), install: vi.fn(), update: vi.fn(), toggle: vi.fn(), authorize: vi.fn(), uninstall: vi.fn(), reveal: vi.fn(), choose: vi.fn() }));
vi.mock("../../src/lib/pluginInventoryServices", () => ({ pluginInventoryServices: (confirm: unknown) => ({
  available: mocks.available, listPlugins: mocks.list, chooseDirectory: mocks.choose, installDirectory: mocks.install,
  updateDirectory: mocks.update, togglePlugin: mocks.toggle, authorizePlugin: mocks.authorize,
  uninstallPlugin: mocks.uninstall, revealPath: mocks.reveal, confirm,
}) }));
const plugin = (id = "codec", enabled = true): InstalledPlugin => ({
  id, name: id, version: "1.0.0", enabled, source_kind: "imported", path: `/offline/plugins/${id}`, created_at: "2026-10-16", updated_at: "2026-10-16",
  manifest: { title: `工具 ${id}`, description: "本地离线工具", main: "index.html", features: [
    { code: `${id}-encode`, label: "编码", explain: "把文本编码" }, { code: `${id}-decode`, label: "解码", explain: "还原文本" },
  ] },
});
let inventory: InstalledPlugin[];
const confirm = vi.fn(async () => true);
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset()); confirm.mockClear(); inventory = [plugin()];
  mocks.available.mockReturnValue(true);
  mocks.list.mockImplementation(async () => inventory);
  mocks.authorize.mockImplementation(async id => { inventory = inventory.map(item => item.id === id ? { ...item, enabled: true } : item); return inventory.find(item => item.id === id); });
  mocks.toggle.mockImplementation(async (id, enabled) => { inventory = inventory.map(item => item.id === id ? { ...item, enabled } : item); });
});
afterEach(() => { cleanup(); localStorage.clear(); });

it("opens the requested plugin's exact feature and returns keyboard focus to its list entry", async () => {
  const requests: CustomEvent[] = [];
  const accept = (event: Event) => { event.preventDefault(); requests.push(event as CustomEvent); (event as CustomEvent).detail.respond({ status: "committed" }); };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, accept);
  try {
    render(PluginInventoryPanel, { confirm });
    const details = await screen.findByRole("button", { name: "查看 工具 codec 详情" });
    await fireEvent.click(details);
    const heading = screen.getByRole("heading", { name: "工具 codec" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole("list", { name: "插件列表" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "打开功能 解码" }));
    expect(requests).toHaveLength(1);
    expect(requests[0].detail).toMatchObject({ pluginId: "codec", code: "codec-decode" });
    await fireEvent.keyDown(heading, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看 工具 codec 详情" })));
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, accept); }
});

it("returns from detail Escape while retaining the filtered page and entry focus", async () => {
  inventory = Array.from({ length: 95 }, (_, index) => plugin(`tool-${String(index).padStart(3, "0")}`));
  render(PluginInventoryPanel, { confirm });
  const filter = await screen.findByRole("textbox", { name: "筛选已安装插件" });
  await fireEvent.input(filter, { target: { value: "tool-" } });
  await fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  const entry = screen.getByRole("button", { name: "查看 工具 tool-030 详情" });
  await fireEvent.click(entry);
  const heading = await screen.findByRole("heading", { name: "工具 tool-030" });
  await waitFor(() => expect(document.activeElement).toBe(heading));

  await fireEvent.keyDown(heading, { key: "Escape" });

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看 工具 tool-030 详情" })));
  expect((screen.getByRole("textbox", { name: "筛选已安装插件" }) as HTMLInputElement).value).toBe("tool-");
  expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("2 / 4");
  expect(document.querySelectorAll("[data-plugin-id]")).toHaveLength(30);
});

it("leaves modified, composing, canceled, and nested-dialog Escape events alone", async () => {
  const detail = pluginInventory([plugin()]).selectedPlugin!;
  const onback = vi.fn();
  const noop = () => {};
  render(PluginInventoryDetail, { detail, enabled: true, locked: false, localLocked: false, opening: false, readDisabled: false,
    onback, onopen: noop, onauthorize: noop, ondisable: noop, onreveal: noop, onupdate: noop, onuninstall: noop });
  const heading = screen.getByRole("heading", { name: "工具 codec" });
  await waitFor(() => expect(document.activeElement).toBe(heading));

  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
    await fireEvent.keyDown(heading, { key: "Escape", [modifier]: true });
  }
  await fireEvent.keyDown(heading, { key: "Escape", isComposing: true });
  const webkitIme = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  Object.defineProperty(webkitIme, "keyCode", { value: 229 });
  heading.dispatchEvent(webkitIme);
  heading.dataset.atoolsComposing = "true";
  await fireEvent.keyDown(heading, { key: "Escape", isComposing: false });
  delete heading.dataset.atoolsComposing;
  const canceled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  canceled.preventDefault();
  heading.dispatchEvent(canceled);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const confirmButton = document.createElement("button");
  dialog.append(confirmButton);
  screen.getByRole("region", { name: "插件详情" }).append(dialog);
  await fireEvent.keyDown(confirmButton, { key: "Escape" });

  expect(onback).not.toHaveBeenCalled();
});

it("authorizes a disabled plugin and requires list-only recovery after a committed action read fails", async () => {
  inventory = [plugin("codec", false)];
  render(PluginInventoryPanel, { confirm });
  const authorize = await screen.findByRole("button", { name: "授权启用 工具 codec" });
  mocks.list.mockRejectedValueOnce(new Error("清单读取失败"));
  await fireEvent.click(authorize);
  await screen.findByRole("button", { name: "重试读取列表" });
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "授权启用插件", message: expect.stringContaining("工具 codec") }));
  expect(mocks.authorize).toHaveBeenCalledWith("codec");
  expect(mocks.toggle).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "打开 工具 codec" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "安装本地插件" }) as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "重试读取列表" }));
  await screen.findByRole("button", { name: "打开 工具 codec" });
  expect(mocks.authorize).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "重试读取列表" })).toBeNull();
});

it("bounds catalogue DOM rows and resets pagination when filtering", async () => {
  inventory = Array.from({ length: 95 }, (_, index) => plugin(`tool-${String(index).padStart(3, "0")}`));
  const { container } = render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "下一页" });
  expect(container.querySelectorAll("[data-plugin-id]")).toHaveLength(30);
  await fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(container.querySelectorAll("[data-plugin-id]")).toHaveLength(30);
  await fireEvent.input(screen.getByRole("textbox", { name: "筛选已安装插件" }), { target: { value: "tool-094" } });
  await screen.findByRole("button", { name: "打开 工具 tool-094" });
  expect(container.querySelectorAll("[data-plugin-id]")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  await fireEvent.input(screen.getByRole("textbox", { name: "筛选已安装插件" }), { target: { value: "无此插件" } });
  await fireEvent.click(await screen.findByRole("button", { name: "清除筛选" }));
  expect(container.querySelectorAll("[data-plugin-id]")).toHaveLength(30);
});

it("preserves permission audit and lets the user clear only the selected plugin's runtime grants", async () => {
  grantPluginRuntimePermission("codec", "clipboard.read");
  grantPluginRuntimePermission("other", "filesystem.read");
  render(PluginInventoryPanel, { confirm, selectedPluginId: "codec" });
  await screen.findByRole("heading", { name: "工具 codec" });
  await fireEvent.click(screen.getByText("插件权限", { selector: "summary" }));
  await fireEvent.click(screen.getByRole("button", { name: "清除授权" }));
  expect(pluginRuntimePermissionGrantList("codec")).toEqual([]);
  expect(pluginRuntimePermissionGrantList("other")).toEqual(["filesystem.read"]);
  expect(screen.getByText("已清除插件运行时授权")).toBeTruthy();
});

it("keeps disabled features visible without giving them open controls", async () => {
  inventory = [plugin("codec", false)];
  render(PluginInventoryPanel, { confirm, selectedPluginId: "codec" });
  const detail = await screen.findByRole("region", { name: "插件详情" });
  expect(within(detail).getByText("解码", { exact: true })).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: "打开功能 解码" })).toBeNull();
  expect(within(detail).getByRole("button", { name: "授权启用", exact: true })).toBeTruthy();
});

it("enables a bundled plugin through its existing toggle command without imported-plugin authorization", async () => {
  inventory = [{ ...plugin("builtin", false), source_kind: "builtin", path: "/atools/resources/plugins/builtin/example" }];
  render(PluginInventoryPanel, { confirm });
  await fireEvent.click(await screen.findByRole("button", { name: "启用 工具 builtin" }));
  await screen.findByRole("button", { name: "打开 工具 builtin" });
  expect(mocks.toggle).toHaveBeenCalledWith("builtin", true);
  expect(mocks.authorize).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
});

it("keeps malformed list data out of the parent and retains the last validated catalogue", async () => {
  const loaded = vi.fn();
  render(PluginInventoryPanel, { confirm, onpluginsloaded: loaded });
  await screen.findByRole("button", { name: "打开 工具 codec" });
  expect(loaded).toHaveBeenCalledTimes(1);
  mocks.list.mockResolvedValueOnce([{ id: "broken", manifest: { features: null } }]);
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  await screen.findByRole("button", { name: "重试读取列表" });
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "打开 工具 codec" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "打开 broken" })).toBeNull();
});

it("holds the operation lock throughout a native directory chooser and opens the installed entry after one commit", async () => {
  let choose!: (directory: string | null) => void;
  mocks.choose.mockReturnValueOnce(new Promise(resolve => { choose = resolve; }));
  const installed = plugin("new");
  mocks.install.mockImplementation(async () => { inventory = [...inventory, installed]; return installed; });
  render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "打开 工具 codec" });
  await fireEvent.click(screen.getByRole("button", { name: "安装本地插件" }));
  expect((screen.getByRole("button", { name: "安装本地插件" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "打开 工具 codec" }) as HTMLButtonElement).disabled).toBe(true);
  choose("/chosen/plugin");
  await screen.findByRole("heading", { name: "工具 new" });
  expect(mocks.install).toHaveBeenCalledTimes(1);
  expect(mocks.install).toHaveBeenCalledWith("/chosen/plugin");
});

it("keeps later plugin features reachable while bounding the detail DOM", async () => {
  inventory = [{ ...plugin(), manifest: { title: "多功能插件", features: Array.from({ length: 47 }, (_, index) => ({
    code: `feature-${index}`, label: `功能 ${index}`, explain: `第 ${index} 个功能`,
  })) } }];
  const opened = vi.fn((event: Event) => { event.preventDefault(); (event as CustomEvent).detail.respond({ status: "committed" }); });
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened);
  try {
    const { container } = render(PluginInventoryPanel, { confirm, selectedPluginId: "codec" });
    await screen.findByRole("heading", { name: "多功能插件" });
    expect(container.querySelectorAll(".feature-row")).toHaveLength(20);
    await fireEvent.click(screen.getByRole("button", { name: "下一页功能" }));
    await fireEvent.click(screen.getByRole("button", { name: "下一页功能" }));
    expect(container.querySelectorAll(".feature-row")).toHaveLength(7);
    await fireEvent.click(screen.getByRole("button", { name: "打开功能 功能 46" }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ pluginId: "codec", code: "feature-46" });
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened); }
});

it("does not reopen a previous installation while enabling another filtered plugin", async () => {
  inventory = [plugin("beta", false)];
  const alpha = plugin("alpha");
  mocks.choose.mockResolvedValueOnce("/chosen/alpha");
  mocks.install.mockImplementation(async () => { inventory = [...inventory, alpha]; return alpha; });
  let authorize!: () => void;
  mocks.authorize.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { authorize = resolve; });
    inventory = inventory.map(item => item.id === "beta" ? { ...item, enabled: true } : item);
    return inventory[0];
  });
  render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "授权启用 工具 beta" });
  await fireEvent.click(screen.getByRole("button", { name: "安装本地插件" }));
  await screen.findByRole("heading", { name: "工具 alpha" });
  await fireEvent.click(screen.getByRole("button", { name: /返回插件列表/ }));
  await fireEvent.input(screen.getByRole("textbox", { name: "筛选已安装插件" }), { target: { value: "beta" } });
  await fireEvent.click(screen.getByRole("button", { name: "授权启用 工具 beta" }));
  await waitFor(() => expect(mocks.authorize).toHaveBeenCalled());
  expect(screen.queryByRole("heading", { name: "工具 alpha" })).toBeNull();
  expect((screen.getByRole("textbox", { name: "筛选已安装插件" }) as HTMLInputElement).value).toBe("beta");
  authorize();
  await screen.findByRole("button", { name: "打开 工具 beta" });
  expect(screen.queryByRole("heading", { name: "工具 alpha" })).toBeNull();
});

it("disables native controls in a browser preview while preserving local permission cleanup", async () => {
  mocks.available.mockReturnValue(false);
  grantPluginRuntimePermission("codec", "clipboard.read");
  render(PluginInventoryPanel, { confirm, initialPlugins: inventory, selectedPluginId: "codec" });
  await screen.findByText("请在桌面应用中管理和打开插件");
  const detail = screen.getByRole("region", { name: "插件详情" });
  for (const name of ["安装本地插件", "立即打开", "停用插件", "更新插件", "卸载插件"]) {
    expect((screen.getByRole("button", { name, exact: true }) as HTMLButtonElement).disabled).toBe(true);
  }
  await fireEvent.click(within(detail).getByText("安装信息", { selector: "summary" }));
  expect((screen.getByRole("button", { name: "打开目录" }) as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(within(detail).getByText("插件权限", { selector: "summary" }));
  await fireEvent.click(screen.getByRole("button", { name: "清除授权" }));
  expect(pluginRuntimePermissionGrantList("codec")).toEqual([]);
  expect(mocks.list).not.toHaveBeenCalled();
});

it("clamps a feature page after updating the same plugin to a smaller manifest", async () => {
  const base = plugin();
  const features = Array.from({ length: 21 }, (_, index) => ({ code: `feature-${index}`, label: `功能 ${index}`, explain: "" }));
  const detail = pluginInventory([{ ...base, manifest: { ...base.manifest, features } }]).selectedPlugin!;
  const noop = () => {};
  const props = { detail, enabled: true, locked: false, localLocked: false, opening: false, readDisabled: false,
    onback: noop, onopen: noop, onauthorize: noop, ondisable: noop, onreveal: noop, onupdate: noop, onuninstall: noop };
  const view = render(PluginInventoryDetail, props);
  await fireEvent.click(screen.getByRole("button", { name: "下一页功能" }));
  expect(screen.getByRole("button", { name: "打开功能 功能 20" })).toBeTruthy();
  await view.rerender({ ...props, detail: { ...detail, features: features.slice(0, 1) } });
  expect(screen.getByRole("button", { name: "打开功能 功能 0" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "功能分页" })).toBeNull();
});

it("uses authoritative imported provenance even when the id and path contain builtin", async () => {
  inventory = [{ ...plugin("builtin-foo", false), source_kind: "imported", path: "/offline/user/plugins/builtin-foo" }];
  render(PluginInventoryPanel, { confirm, selectedPluginId: "builtin-foo" });
  const detail = await screen.findByRole("region", { name: "插件详情" });
  expect(within(detail).getByText("导入", { exact: true })).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "更新插件" })).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "卸载插件" })).toBeTruthy();
  await fireEvent.click(within(detail).getByRole("button", { name: "授权启用", exact: true }));
  await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith("builtin-foo"));
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "授权启用插件" }));
  expect(mocks.toggle).not.toHaveBeenCalled();
});

it("hides update and uninstall for an external directory while requiring consent to enable it", async () => {
  inventory = [{ ...plugin("external", false), source_kind: "external", path: "/external/tools/example" }];
  render(PluginInventoryPanel, { confirm, selectedPluginId: "external" });
  const detail = await screen.findByRole("region", { name: "插件详情" });
  expect(within(detail).queryByRole("button", { name: "更新插件" })).toBeNull();
  expect(within(detail).queryByRole("button", { name: "卸载插件" })).toBeNull();
  await fireEvent.click(within(detail).getByRole("button", { name: "授权启用", exact: true }));
  await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith("external"));
  expect(confirm).toHaveBeenCalled(); expect(mocks.toggle).not.toHaveBeenCalled();
});

it("requires authorization when old metadata only suggests a bundled-looking path", async () => {
  const legacy = { ...plugin("legacy", false), path: "/offline/plugins/builtin-looking" };
  delete legacy.source_kind;
  inventory = [legacy];
  render(PluginInventoryPanel, { confirm });
  expect(await screen.findByText("待确认", { exact: true })).toBeTruthy();
  await fireEvent.click(await screen.findByRole("button", { name: "授权启用 工具 legacy" }));
  await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith("legacy"));
  expect(confirm).toHaveBeenCalled(); expect(mocks.toggle).not.toHaveBeenCalled();
});


it("moves successful catalogue reads out of the visible layout while retaining a live announcement", async () => {
  const { container } = render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "打开 工具 codec" });
  const announcement = container.querySelector(".inventory-announcement");
  expect(announcement?.textContent).toBe("已读取 1 个插件");
  expect(announcement?.getAttribute("aria-live")).toBe("polite");
  expect(container.querySelector(".notice")).toBeNull();
});

it("keeps a read failure visible and locks writes until list-only recovery succeeds", async () => {
  const { container } = render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "打开 工具 codec" });
  mocks.list.mockRejectedValueOnce(new Error("offline catalogue"));
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  const retry = await screen.findByRole("button", { name: "重试读取列表" });
  expect(container.querySelector('[data-feedback-kind="read-failure"]')?.textContent).toContain("offline catalogue");
  expect((screen.getByRole("button", { name: "安装本地插件" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "打开 工具 codec" }) as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(retry);
  await waitFor(() => expect(container.querySelector(".notice")).toBeNull());
  expect((screen.getByRole("button", { name: "安装本地插件" }) as HTMLButtonElement).disabled).toBe(false);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("keeps operation progress visible until the catalogue read completes", async () => {
  let resolve!: (plugins: InstalledPlugin[]) => void;
  mocks.list.mockReturnValueOnce(new Promise<InstalledPlugin[]>(done => { resolve = done; }));
  const { container } = render(PluginInventoryPanel, { confirm });
  expect(container.querySelector('[data-feedback-kind="progress"]')?.textContent).toContain("正在读取插件清单");
  expect(container.querySelector(".inventory-announcement")).toBeNull();
  resolve(inventory);
  await screen.findByRole("button", { name: "打开 工具 codec" });
  expect(container.querySelector(".notice")).toBeNull();
});
