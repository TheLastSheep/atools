import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ZToolsImportPanel from "../../src/components/ZToolsImportPanel.svelte";
import type { ZToolsImportCandidate } from "../../src/lib/types";
import { ztoolsImportSelectionSession } from "../../src/lib/ztoolsImportSelectionSession";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

function candidate(path: string, overrides: Partial<ZToolsImportCandidate> = {}): ZToolsImportCandidate {
  return { path, source_type: "directory", installation_id: "calculator", entry_readiness: "ready", name: "calculator",
    title: "计算器", version: "1.0.0", features_count: 1, platform_supported: true, main_exists: true, preload_exists: true,
    logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [], ...overrides };
}
const source = candidate("/sources/calculator", { entry_readiness: "requires_build" });
const oldArchive = candidate("/sources/calculator/release.zpx", { source_type: "zpx", version: "0.9.0" });
const newArchive = candidate("/sources/calculator/release.zip", { source_type: "zip", version: "2.0.0" });
const unique = candidate("/sources/text-tool", { installation_id: "text-tool", name: "text-tool", title: "文本工具" });

function checkbox(path: string): HTMLInputElement {
  return document.getElementById(`ztools-import-${encodeURIComponent(path)}`) as HTMLInputElement;
}
function sourceRow(path: string): HTMLElement {
  return checkbox(path).closest(".candidate-row") as HTMLElement;
}
beforeEach(() => {
  ztoolsImportSelectionSession.clear();
  mocks.invoke.mockReset(); mocks.open.mockReset();
  mocks.invoke.mockImplementation(async command => {
    if (command === "scan_default_ztools_plugins") return [source, oldArchive, newArchive, unique];
    if (command === "import_ztools_plugins") return { imported: [], skipped: [], failed: [] };
    if (command === "list_plugins") return [];
    return undefined;
  });
});
afterEach(() => { cleanup(); ztoolsImportSelectionSession.clear(); });

describe("ZTools import source choices in the panel", () => {
  it("leaves every ambiguous source empty, while keeping path, version and package type visible", async () => {
    render(ZToolsImportPanel);
    await screen.findByRole("button", { name: "导入 1 个插件" });
    expect(checkbox(source.path).disabled).toBe(true);
    expect(checkbox(oldArchive.path).checked).toBe(false);
    expect(checkbox(newArchive.path).checked).toBe(false);
    expect(checkbox(unique.path).checked).toBe(true);
    expect(within(sourceRow(oldArchive.path)).getByText("calculator · 0.9.0 · ZPX · 1 指令")).toBeTruthy();
    expect(within(sourceRow(newArchive.path)).getByText("calculator · 2.0.0 · ZIP · 1 指令")).toBeTruthy();
    expect(within(sourceRow(oldArchive.path)).getByText(oldArchive.path).title).toBe(oldArchive.path);
    expect(screen.getByText(/1 个插件有多个来源，1 个尚未选择/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "选择无冲突来源" }));
    expect(checkbox(oldArchive.path).checked).toBe(false);
    expect(checkbox(newArchive.path).checked).toBe(false);
    expect(screen.getByRole("button", { name: "导入 1 个插件" })).toBeTruthy();
  });

  it("replaces only the peer source on native checkbox activation and imports exact selected paths", async () => {
    render(ZToolsImportPanel);
    await screen.findByRole("button", { name: "导入 1 个插件" });
    const older = checkbox(oldArchive.path);
    older.focus();
    expect(document.activeElement).toBe(older);
    expect(older.getAttribute("aria-describedby")).toBe(`ztools-source-choice-${encodeURIComponent(oldArchive.path)}`);
    await fireEvent.click(older);
    expect(checkbox(oldArchive.path).checked).toBe(true);
    await fireEvent.click(checkbox(newArchive.path));
    expect(checkbox(oldArchive.path).checked).toBe(false);
    expect(checkbox(newArchive.path).checked).toBe(true);
    expect(checkbox(unique.path).checked).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "选择无冲突来源" }));
    expect(checkbox(newArchive.path).checked).toBe(true);
    expect(screen.getByText(/1 个插件有多个来源，0 个尚未选择/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "导入 2 个插件" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("import_ztools_plugins", { paths: [newArchive.path, unique.path], overwrite: true }));
  });

  it("restores a manual source choice after leaving and reopening the panel", async () => {
    const first = render(ZToolsImportPanel);
    await screen.findByRole("button", { name: "导入 1 个插件" });
    await fireEvent.click(checkbox(oldArchive.path));
    expect(checkbox(oldArchive.path).checked).toBe(true);
    first.unmount();

    render(ZToolsImportPanel);
    await waitFor(() => expect(checkbox(oldArchive.path).checked).toBe(true));
    expect(checkbox(newArchive.path).checked).toBe(false);
    expect(screen.getByRole("button", { name: "导入 2 个插件" })).toBeTruthy();
  });

  it("keeps the source's archive guidance and explicit market action independent from selection", async () => {
    const onmarketrequest = vi.fn();
    render(ZToolsImportPanel, { onmarketrequest });
    await screen.findByRole("button", { name: "导入 1 个插件" });
    expect(within(sourceRow(source.path)).getByText(/已有可导入的安装包/)).toBeTruthy();
    await fireEvent.click(within(sourceRow(source.path)).getByRole("button", { name: "在官方市场查找发布版" }));
    expect(onmarketrequest).toHaveBeenCalledWith({ source: "official_ztools", pluginName: "calculator" });
    expect(checkbox(oldArchive.path).checked).toBe(false);
    expect(checkbox(newArchive.path).checked).toBe(false);
  });

  it("clears a chosen version and does not repick it through select-all", async () => {
    render(ZToolsImportPanel);
    await screen.findByRole("button", { name: "导入 1 个插件" });
    await fireEvent.click(checkbox(oldArchive.path));
    await fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
    expect((screen.getByRole("button", { name: "导入 0 个插件" }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "选择无冲突来源" }));
    expect(checkbox(oldArchive.path).checked).toBe(false);
    expect(checkbox(newArchive.path).checked).toBe(false);
    expect(checkbox(unique.path).checked).toBe(true);
  });

  it("keeps a newly chosen version when an old failure is retried", async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === "scan_default_ztools_plugins") return [oldArchive, newArchive];
      if (command === "import_ztools_plugins") return { imported: [], skipped: [], failed: [{ path: oldArchive.path, error: "暂时失败" }] };
      if (command === "list_plugins") return [];
      return undefined;
    });
    render(ZToolsImportPanel);
    await screen.findByRole("button", { name: "导入 0 个插件" });
    await fireEvent.click(checkbox(oldArchive.path));
    await fireEvent.click(screen.getByRole("button", { name: "导入 1 个插件" }));
    const retry = await screen.findByRole("button", { name: /重试失败/ });
    await waitFor(() => expect(checkbox(newArchive.path).disabled).toBe(false));
    await fireEvent.click(checkbox(newArchive.path));
    await fireEvent.click(retry);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "import_ztools_plugins")).toHaveLength(1);
    expect(checkbox(oldArchive.path).checked).toBe(false);
    expect(checkbox(newArchive.path).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("其他选择");
  });
});
