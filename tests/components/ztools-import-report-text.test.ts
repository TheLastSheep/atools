import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import ZToolsImportResults from "../../src/components/ZToolsImportResults.svelte";

afterEach(() => cleanup());

it("keeps a long failure reason and exact source path with a working retry action", async () => {
  const path = "/fixture/source-choice/calculator/published-calculator-with-a-long-package-name-0.9.0.zpx";
  const error = "安装包暂时无法写入。请检查目标目录后重试，已选来源会保留；请勿重新选择同一插件的其他版本。";
  const onRetryFailures = vi.fn();
  render(ZToolsImportResults, {
    report: { imported: [], skipped: [], failed: [{ path, error }] }, importedPlugins: {}, enableErrors: {},
    pendingEnableRefresh: new Set(), busy: false, refreshError: "", pluginOpenState: { requestId: null, pluginId: null, busy: false, message: "" },
    onEnable: vi.fn(), onRetryEnableRead: vi.fn(), onOpen: vi.fn(), onRetryList: vi.fn(), onRetryFailures,
  });
  expect(screen.getByText(error, { exact: true })).toBeTruthy();
  expect(screen.getByText(path, { exact: true })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "重试失败 1 个" }));
  expect(onRetryFailures).toHaveBeenCalledOnce();
});
