import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ZToolsImportCandidateRow from "../../src/components/ZToolsImportCandidateRow.svelte";
import { ztoolsImportView } from "../../src/lib/ztoolsImportView";
import type { ZToolsImportCandidate } from "../../src/lib/types";

function candidate(overrides: Partial<ZToolsImportCandidate> = {}): ZToolsImportCandidate {
  return {
    path: "/tmp/plugins/source-plugin",
    source_type: "directory",
    entry_readiness: "requires_build",
    name: "source-plugin-manifest-name",
    title: "与 manifest 名称不同的中文标题",
    version: "1.0.0",
    features_count: 1,
    platform_supported: true,
    main_exists: true,
    preload_exists: true,
    logo_exists: true,
    unsupported_cmd_types: [],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("ZTools source import market recovery", () => {
  it("keeps requires_build rows unselectable and queries by the manifest name", () => {
    const view = ztoolsImportView([candidate()], new Set(["/tmp/plugins/source-plugin"]));
    const [row] = view.rows;
    expect(row.title).toBe("与 manifest 名称不同的中文标题");
    expect(row.readiness).toBe("requires_build");
    expect(row.selectable).toBe(false);
    expect(row.selected).toBe(false);
    expect(row.statusLabel).toBe("需要发布版");
    expect(row.readinessMessage).toContain("需要先获得可运行的发布版");
    expect(row.marketRequest).toEqual({ source: "official_ztools", pluginName: "source-plugin-manifest-name" });
  });

  it("offers no market action for an unrelated blocked candidate", () => {
    const row = ztoolsImportView([candidate({ entry_readiness: "incomplete", errors: ["main 入口不存在"] })], new Set()).rows[0];
    expect(row.selectable).toBe(false);
    expect(row.marketRequest).toBeNull();
  });

  it("blocks an incompatible local release even when the scanner supplied no error text", async () => {
    const row = ztoolsImportView([candidate({ entry_readiness: "ready", platform_supported: false })], new Set()).rows[0];
    const onmarketrequest = vi.fn();
    render(ZToolsImportCandidateRow, { row, ontoggle: vi.fn(), onmarketrequest });
    expect(row.statusLabel).toBe("本地版本不支持当前系统");
    expect(row.readinessMessage).toContain("是否已支持当前系统");
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "在官方市场查找发布版" }));
    expect(onmarketrequest).toHaveBeenCalledWith({ source: "official_ztools", pluginName: "source-plugin-manifest-name" });
  });

  it("sends only the typed market request without toggling the candidate checkbox", async () => {
    const row = ztoolsImportView([candidate()], new Set()).rows[0];
    const onmarketrequest = vi.fn();
    render(ZToolsImportCandidateRow, { props: { row, ontoggle: vi.fn(), onmarketrequest } });
    const action = screen.getByRole("button", { name: "在官方市场查找发布版" });
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);

    await fireEvent.click(action);
    expect(onmarketrequest).toHaveBeenCalledTimes(1);
    expect(onmarketrequest).toHaveBeenCalledWith({ source: "official_ztools", pluginName: "source-plugin-manifest-name" });
    expect(checkbox.checked).toBe(false);
  });

  it("keeps metadata clickable through a real label while the market button stays outside it", async () => {
    const selectable = candidate({ entry_readiness: "ready", warnings: ["检查提醒"] });
    const row = {
      ...ztoolsImportView([selectable], new Set()).rows[0],
      marketRequest: { source: "official_ztools" as const, pluginName: selectable.name },
    };
    const ontoggle = vi.fn();
    const onmarketrequest = vi.fn();
    render(ZToolsImportCandidateRow, { props: { row, ontoggle, onmarketrequest } });

    const title = screen.getByText("与 manifest 名称不同的中文标题");
    const label = title.closest("label");
    const action = screen.getByRole("button", { name: "在官方市场查找发布版" });
    expect(label?.htmlFor).toBe("ztools-import-%2Ftmp%2Fplugins%2Fsource-plugin");
    expect(action.closest("label")).toBeNull();

    await fireEvent.click(title);
    expect(ontoggle).toHaveBeenCalledWith(selectable.path, true);
  });

  it("uses a focusable native button and disables it while busy", async () => {
    const row = ztoolsImportView([candidate()], new Set()).rows[0];
    const onmarketrequest = vi.fn();
    const { rerender } = render(ZToolsImportCandidateRow, {
      props: { row, ontoggle: vi.fn(), onmarketrequest },
    });
    const action = screen.getByRole("button", { name: "在官方市场查找发布版" }) as HTMLButtonElement;
    expect(action.type).toBe("button");
    action.focus();
    expect(document.activeElement).toBe(action);
    expect(onmarketrequest).not.toHaveBeenCalled();

    await rerender({ row, disabled: true, ontoggle: vi.fn(), onmarketrequest });
    await waitFor(() => expect(action.disabled).toBe(true));
  });

  it("omits the action when no route callback is available", () => {
    const row = ztoolsImportView([candidate()], new Set()).rows[0];
    render(ZToolsImportCandidateRow, { props: { row, ontoggle: vi.fn() } });
    expect(screen.queryByRole("button", { name: "在官方市场查找发布版" })).toBeNull();
  });
});
