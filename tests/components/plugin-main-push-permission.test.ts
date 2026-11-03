import { expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import PermissionConfirmDialog from "../../src/components/PermissionConfirmDialog.svelte";
import { permissionRequestContext, pluginMainPushPermissionPresentation } from "../../src/lib/permissionPresentation";
import type { PendingAgentToolRequest } from "../../src/lib/types";
const request = { id: "request", tool_name: "plugin_main_push_" + "a".repeat(64), client_id: "atools-ui", arguments: { intentId: "opaque-metadata" },
  scopes: [], created_at: "2026-10-19T00:00:00Z" } as unknown as PendingAgentToolRequest;
afterEach(cleanup);
it("names the exact backend plugin in the search permission, keeping internals in technical details", () => {
  render(PermissionConfirmDialog, { request, displayName: "计算稿纸", requestContext: permissionRequestContext({ kind: "plugin_main_push", pluginName: "计算稿纸" }),
    onallowonce: vi.fn(), onallowremember: vi.fn(), ondeny: vi.fn() });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("计算稿纸 查询搜索结果");
  expect(screen.getByText("在主搜索中运行此插件")).toBeTruthy();
  expect(screen.getByText("文件、网络、剪贴板和本机进程仍按各自的权限处理。")).toBeTruthy();
  expect(document.querySelector(".technical-details")?.textContent).toContain(request.tool_name);
  expect(document.querySelector(".arguments")).toBeNull(); expect(document.body.textContent).not.toContain("opaque-metadata");
});
it("does not select the private prompt by tool-name prefix or incorrect scopes", () => {
  expect(pluginMainPushPermissionPresentation(request, permissionRequestContext({ kind: "tool", pluginName: "Fixed" }))).toBeNull();
  expect(pluginMainPushPermissionPresentation({ ...request, scopes: ["shell"] }, permissionRequestContext({ kind: "plugin_main_push", pluginName: "Fixed" }))).toBeNull();
});
