import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import LauncherTabTargetPicker from "../../src/components/LauncherTabTargetPicker.svelte";
import { tabTargetFromFeature } from "../../src/lib/launcherTabTarget";
import type { SearchResult } from "../../src/lib/types";
const feature: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换工具", label: "当前名称", explain: "", icon: null, score: 1, match_type: "catalog" };
afterEach(cleanup);
it("searches actual targets without repeated IPC and chooses stable owner/code", async () => {
  const onchange = vi.fn(), loadCatalog = vi.fn(async () => [feature, { ...feature, code: "builtin-json", plugin_id: "builtin.json", label: "JSON 工具" }]);
  render(LauncherTabTargetPicker, { value: null, onchange, loadCatalog });
  await screen.findByRole("button", { name: /当前名称/ });
  const search = screen.getByRole("searchbox");
  await fireEvent.input(search, { target: { value: "no matching tool" } });
  const emptyStatusText = "没有匹配的可用工具，请调整搜索或启用插件后刷新。";
  const emptyStatus = await screen.findByText(emptyStatusText);
  expect(emptyStatus.getAttribute("role")).toBe("status");
  const unsetTargetStatus = screen.getByText("尚未设置 Tab 目标，请选择一个工具。");
  expect(unsetTargetStatus.getAttribute("role")).toBe("status");
  await fireEvent.input(search, { target: { value: "converter" } });
  expect(screen.queryByText(emptyStatusText)).toBeNull();
  expect(screen.getByText("尚未设置 Tab 目标，请选择一个工具。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /JSON 工具/ })).toBeNull();
  await fireEvent.click(await screen.findByRole("button", { name: /当前名称/ }));
  expect(onchange).toHaveBeenCalledTimes(1); expect(onchange).toHaveBeenCalledWith(tabTargetFromFeature(feature));
  expect(loadCatalog).toHaveBeenCalledTimes(1);
});
it("restores current identity, displays live renamed label and marks disabled/removal on refresh", async () => {
  const loadCatalog = vi.fn(async () => [feature]);
  const onchange = vi.fn();
  render(LauncherTabTargetPicker, { value: { ...tabTargetFromFeature(feature), label: "旧名称" }, onchange, loadCatalog });
  await screen.findByRole("button", { name: /当前名称/ });
  expect(screen.queryByText("旧名称")).toBeNull();
  loadCatalog.mockResolvedValueOnce([]);
  await fireEvent.click(screen.getByRole("button", { name: "刷新工具" }));
  const disabledStatusText = "Tab 目标已禁用、移除或来源已变化，请重新选择工具。";
  await waitFor(() => expect(screen.getByText(disabledStatusText).getAttribute("role")).toBe("status"));
  const emptyCatalogStatus = screen.getByText("没有匹配的可用工具，请调整搜索或启用插件后刷新。");
  expect(emptyCatalogStatus.getAttribute("role")).toBe("status");
  expect(screen.getByText("旧名称")).toBeTruthy();
  expect(onchange).not.toHaveBeenCalled();
});
it("never silently reselects a same-code other owner, disables collisions and supports clearing", async () => {
  const onchange = vi.fn();
  render(LauncherTabTargetPicker, { value: tabTargetFromFeature(feature), onchange,
    loadCatalog: async () => [feature, { ...feature, plugin_id: "intruder" }] });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("多个来源"));
  for (const row of screen.getAllByRole("button", { name: /当前名称/ })) expect((row as HTMLButtonElement).disabled).toBe(true);
  expect(onchange).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole("button", { name: "清除目标" })); expect(onchange).toHaveBeenLastCalledWith(null);
});
it("catalog failure stays actionable and retry recovers", async () => {
  const loadCatalog = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce([feature]);
  render(LauncherTabTargetPicker, { value: null, onchange: vi.fn(), loadCatalog });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("无法读取"));
  await fireEvent.click(screen.getByRole("button", { name: "刷新工具" }));
  expect(await screen.findByRole("button", { name: /当前名称/ })).toBeTruthy();
});
