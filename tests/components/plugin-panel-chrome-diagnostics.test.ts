import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginPanelChrome from "../../src/components/PluginPanelChrome.svelte";

afterEach(cleanup);

type ChromeProps = ComponentProps<typeof PluginPanelChrome>;

function props(overrides: Partial<ChromeProps> = {}): ChromeProps {
  return {
    visible: true,
    title: "Calculator",
    feature: "calculate",
    actions: [],
    inputVisible: false,
    value: "",
    placeholder: "Search",
    onInput: vi.fn(),
    onReturn: vi.fn(),
    onEscape: vi.fn(),
    onMove: () => false,
    onBoundary: () => false,
    onActivate: () => false,
    onAction: vi.fn(),
    showDiagnostics: false,
    diagnosticsChips: [{ label: "运行状态", value: "就绪", detail: "插件已响应", tone: "ready" as const }],
    diagnosticIdentity: { featureCode: "calculate", source: "calculator" },
    displayStatus: null,
    hostClipboardStatus: null,
    dialogsStatus: null,
    pathsStatus: null,
    dataStatus: null,
    reopening: false,
    onReopenData: vi.fn(),
    onReopenClipboard: vi.fn(),
    onReopenPaths: vi.fn(),
    ...overrides,
  };
}

describe("PluginPanelChrome runtime information disclosure", () => {
  it("keeps ready details collapsed until requested and resets on plugin identity change", async () => {
    const view = render(PluginPanelChrome, props());
    const button = screen.getByRole("button", { name: "运行信息" });
    const regionId = button.getAttribute("aria-controls");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(regionId).toMatch(/^atools-plugin-runtime-info-\d+$/);
    const details = view.container.querySelector(".plugin-diagnostics") as HTMLDetailsElement;
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect(details.open).toBe(false);
    expect(view.container.querySelector(`#${regionId} .plugin-runtime-strip`)).toBeTruthy();

    await fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(details.open).toBe(true);
    expect(view.container.querySelector(`#${regionId} .plugin-runtime-strip`)).toBeTruthy();

    await view.rerender({ diagnosticIdentity: { featureCode: "other", source: "other-plugin" } });
    const resetButton = screen.getByRole("button", { name: "运行信息" });
    expect(resetButton.getAttribute("aria-expanded")).toBe("false");
    expect(details.open).toBe(false);
    expect(view.container.querySelector(`#${regionId} .plugin-runtime-strip`)).toBeTruthy();
  });

  it("keeps preview diagnostics expanded and exposes warning/error status before opening", async () => {
    const preview = render(PluginPanelChrome, props({ showDiagnostics: true }));
    expect(screen.queryByRole("button", { name: /运行信息/ })).toBeNull();
    expect(preview.container.querySelector(".plugin-runtime-strip")).toBeTruthy();
    expect((preview.container.querySelector(".plugin-diagnostics") as HTMLDetailsElement).open).toBe(true);
    preview.unmount();

    const warning = render(PluginPanelChrome, props({ diagnosticsChips: [
      { label: "运行状态", value: "需检查", detail: "权限尚未批准", tone: "warning" },
    ] }));
    const warningButton = screen.getByRole("button", { name: "运行信息，有警告" });
    expect(warningButton.querySelector(".runtime-info-attention")?.textContent).toBe("•");
    const warningDetails = warning.container.querySelector(".plugin-diagnostics") as HTMLDetailsElement;
    expect(warningDetails.open).toBe(false);
    expect(warning.container.querySelector(".plugin-runtime-strip")).toBeTruthy();
    await fireEvent.click(warningButton);
    expect(warningDetails.open).toBe(true);
    expect(warning.container.querySelector(".plugin-runtime-strip")).toBeTruthy();
    warning.unmount();

    render(PluginPanelChrome, props({ diagnosticsChips: [
      { label: "运行状态", value: "失败", detail: "页面加载失败", tone: "error" },
    ] }));
    const errorButton = screen.getByRole("button", { name: "运行信息，有错误" });
    expect(errorButton.querySelector(".runtime-info-attention")?.textContent).toBe("!");
  });
});
