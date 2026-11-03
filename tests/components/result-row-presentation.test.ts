import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultRow from "../../src/components/ResultRow.svelte";
import { resultRowPresentation } from "../../src/lib/resultPresentation";
import type { SearchResult } from "../../src/lib/types";

afterEach(cleanup);
const color: SearchResult = { code: "color", plugin_id: "color-helper", plugin_name: "颜色助手", label: "颜色",
  explain: "颜色", icon: null, score: 100, match_type: "contains" };

describe("readable launcher result rows", () => {
  it("emphasizes the readable title and source without visible code or matching diagnostics", () => {
    render(ResultRow, { result: color, index: 3, selected: true, query: "颜", onselect: vi.fn(), onselectionchange: vi.fn() });
    const row = screen.getByRole("option", { name: "颜色，颜色助手，Enter 执行" });
    expect(row.textContent?.replace(/\s+/g, "")).toBe("颜色颜色助手↵");
    expect(row.textContent).not.toContain("color");
    expect(row.textContent).not.toContain("包含");
    expect(row.getAttribute("data-result-code")).toBe("color");
    expect(row.getAttribute("data-plugin-id")).toBe("color-helper");
    expect(row.querySelector(".result-desc")).toBeNull();
    expect(row.querySelector(".source-name")?.getAttribute("title")).toBe("color-helper · 颜色助手 · 包含匹配");
    expect(row.querySelector("mark")?.textContent).toBe("颜");
    expect(row.querySelector("kbd")?.getAttribute("aria-hidden")).toBe("true");
    expect(row.getAttribute("aria-describedby")).toBeNull();
  });
  it("keeps a distinct description available to both readers and assistive technology", () => {
    const result = { ...color, label: "收藏颜色", explain: "为常用色值添加名称并保存" };
    render(ResultRow, { result, index: 1, selected: false, query: "保存", onselect: vi.fn(), onselectionchange: vi.fn() });
    const row = screen.getByRole("option", { name: "收藏颜色，颜色助手" });
    const description = document.getElementById(row.getAttribute("aria-describedby")!);
    expect(description?.textContent).toBe(result.explain);
    expect(description?.querySelector("mark")?.textContent).toBe("保存");
    expect(row.querySelector("kbd")?.classList.contains("visible")).toBe(false);
  });
  it("activates and opens actions for the original result identity after presentation changes", async () => {
    const onselect = vi.fn(), onselectionchange = vi.fn(), oncommandmenu = vi.fn();
    render(ResultRow, { result: color, index: 7, selected: false, query: "", onselect, onselectionchange, oncommandmenu });
    const row = screen.getByRole("option");
    await fireEvent.mouseEnter(row);
    expect(onselectionchange).toHaveBeenCalledWith(7);
    await fireEvent.click(row);
    expect(onselect).toHaveBeenCalledWith(7);
    await fireEvent.contextMenu(row);
    expect(oncommandmenu.mock.calls[0][1]).toBe(color);
    expect(color.code).toBe("color");
    expect(color.plugin_id).toBe("color-helper");
  });
  it("escapes plugin text while preserving literal search highlights", () => {
    const result = { ...color, label: '<img src=x onerror="bad()">', explain: '<script>bad()</script>' };
    render(ResultRow, { result, index: 0, selected: true, query: "bad", onselect: vi.fn(), onselectionchange: vi.fn() });
    const row = screen.getByRole("option");
    expect(row.querySelector("script")).toBeNull();
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector(".result-title")?.textContent).toBe(result.label);
    expect(row.querySelector(".result-desc")?.textContent).toBe(result.explain);
    expect(row.querySelectorAll("mark")).toHaveLength(2);
  });
  it("suppresses only duplicate descriptions and preserves explicitly declared technical names", () => {
    expect(resultRowPresentation({ ...color, label: " MD5 ", explain: "MD5" }, { selected: false }).description).toBe("");
    expect(resultRowPresentation({ ...color, label: "MD5", explain: "计算文本摘要" }, { selected: false }).description).toBe("计算文本摘要");
  });
});
