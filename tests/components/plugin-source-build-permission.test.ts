import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/svelte";
import PermissionConfirmDialog from "../../src/components/PermissionConfirmDialog.svelte";
import { sourceBuildPermissionPresentation } from "../../src/lib/pluginSourceBuildPermissions";
import type { PendingAgentToolRequest } from "../../src/lib/types";

function request(overrides: Partial<PendingAgentToolRequest> = {}): PendingAgentToolRequest {
  return { id: "permission-build", run_id: "run-build", client_id: "atools-ui", tool_name: "convert_ztools_plugin",
    arguments: { sourcePath: "/private/tmp/selected-project", expectedRevision: "a".repeat(64), overwrite: true },
    scopes: ["file_read", "file_write", "shell"], created_at: "2026-10-19T00:00:00Z", ...overrides };
}

describe("source conversion approval", () => {
  it("shows the selected project and replacement choice with a readable action", () => {
    render(PermissionConfirmDialog, { request: request(), onallowonce() {}, onallowremember() {}, ondeny() {} });
    expect(screen.getByRole("heading", { name: "转换并安装本地插件" })).toBeTruthy();
    expect(screen.getByText("项目目录").parentElement?.textContent).toContain("/private/tmp/selected-project");
    expect(screen.getByText("验证新产物后替换")).toBeTruthy();
    expect(screen.getByText("仅使用已有本地依赖，不会自动下载或安装依赖。")).toBeTruthy();
    expect(screen.getByText("可能包含类型检查、测试、打包和本地构建脚本；实际顺序见所选项目的检查步骤。")).toBeTruthy();
  });
  it("does not relabel a plugin tool or mismatched/duplicate scope request", () => {
    for (const value of [request({ tool_name: "plugin_example_convert_ztools_plugin" }), request({ scopes: ["file_read", "shell"] }),
      request({ scopes: ["file_read", "file_read", "shell"] }), request({ scopes: ["file_read", "file_write", "shell", "network"] })]) {
      expect(sourceBuildPermissionPresentation(value)).toBeNull();
    }
  });
  it("distinguishes inspection from code execution and preserves an existing installation", () => {
    expect(sourceBuildPermissionPresentation(request({ tool_name: "inspect_ztools_source_build", scopes: ["file_read"] }))?.title).toBe("检查本地插件项目");
    expect(sourceBuildPermissionPresentation(request({ arguments: { sourcePath: "/tmp/project", overwrite: false } }))?.arguments[1].value).toBe("保留现有插件");
  });
});
