import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ResultsList from "../../src/components/ResultsList.svelte";
import type { SearchResult } from "../../src/lib/types";

afterEach(cleanup);

const results: SearchResult[] = Array.from({ length: 1200 }, (_, index) => ({
  code: `command-${index}`,
  plugin_id: `plugin-${index % 12}`,
  plugin_name: `插件 ${index % 12}`,
  label: `测试命令 ${index}`,
  icon: null,
  explain: `命令说明 ${index}`,
  score: 1200 - index,
  match_type: "contains",
}));

it("keeps a 1200-result palette bounded while preserving offscreen selection and activation", async () => {
  const onselect = vi.fn();
  const startedAt = performance.now();
  const view = render(ResultsList, { results, selectedIndex: 0, query: "测试", onselect });
  await tick();
  const initialRenderMs = performance.now() - startedAt;
  const initialRows = screen.getAllByRole("option").length;
  console.info(JSON.stringify({ benchmark: "result-list-1200", initialRenderMs, initialRows }));
  expect(initialRows).toBeLessThanOrEqual(32);

  await view.rerender({ selectedIndex: 1199 });
  const selected = screen.getByRole("option", { selected: true });
  expect(selected.getAttribute("data-result-index")).toBe("1199");
  expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(32);
  await fireEvent.click(selected);
  expect(onselect).toHaveBeenLastCalledWith(1199);

  const previousIndexes = new Set(screen.getAllByRole("option").map((row) => row.getAttribute("data-result-index")));
  await fireEvent.scroll(screen.getByRole("listbox"), { target: { scrollTop: 20_000 } });
  const scrolledRows = screen.getAllByRole("option");
  expect(scrolledRows.length).toBeLessThanOrEqual(32);
  expect(scrolledRows.some((row) => !previousIndexes.has(row.getAttribute("data-result-index")))).toBe(true);
  expect(screen.getByRole("option", { selected: true }).getAttribute("data-result-index")).toBe("1199");
});
