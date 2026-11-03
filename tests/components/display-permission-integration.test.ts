import { describe, expect, it, vi } from "vitest";
import { permissionRequestContext } from "../../src/lib/permissionPresentation";
import { pluginDisplayPermissionPresentation } from "../../src/lib/pluginDisplayPermission";
import { reopenPluginHost } from "../../src/lib/pluginHostReopen";
import type { PendingAgentToolRequest } from "../../src/lib/types";

const request: PendingAgentToolRequest = { id: "request", run_id: "run", client_id: "atools-ui", tool_name: "display-tool",
  arguments: { operation: "open" }, scopes: ["display_read"], created_at: "2026-10-19T00:00:00Z" };
describe("display permission and coordinated reopen", () => {
  it("selects metadata wording only from the exact backend kind and scope", () => {
    const context = permissionRequestContext({ kind: "plugin_display", pluginName: " 测试插件 ", cursor: "PRIVATE", endpoint: "PRIVATE" });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
    const presentation = pluginDisplayPermissionPresentation(request, context)!;
    expect(presentation.title).toBe("测试插件 请求读取显示器信息");
    expect(presentation.riskHints.join("")).toContain("当前鼠标位置");
    expect(presentation.retryHint).toContain("重新打开");
    for (const scopes of [["screenshot"], ["display_read", "screenshot"], []]) {
      expect(pluginDisplayPermissionPresentation({ ...request, scopes }, context)).toBeNull();
    }
    expect(pluginDisplayPermissionPresentation(request, null)).toBeNull();
    expect(pluginDisplayPermissionPresentation(request, permissionRequestContext({ kind: "tool" }))).toBeNull();
  });
  it("drains display and clipboard successors together after another transfer fails", async () => {
    const invoke = vi.fn(async () => undefined);
    await expect(reopenPluginHost({ pluginId: "fixture", invoke, current: () => true,
      clipboard: { reopen: async () => ({ instanceId: "clipboard-next" }) },
      display: { reopen: async () => ({ instanceId: "display-next" }) },
      data: { reopen: async () => { throw new Error("cancelled"); } },
    })).rejects.toThrow();
    expect(invoke.mock.calls).toEqual([
      ["close_host_clipboard", { pluginId: "fixture", instanceId: "clipboard-next" }],
      ["close_plugin_display", { pluginId: "fixture", instanceId: "display-next" }],
    ]);
  });
  it("retains a display successor only while the host generation remains current", async () => {
    const invoke = vi.fn(async () => undefined);
    const next = await reopenPluginHost({ pluginId: "fixture", invoke, current: () => true,
      clipboard: { reopen: async () => ({ instanceId: "clipboard-next" }) },
      display: { reopen: async () => ({ instanceId: "display-next" }) },
    });
    expect(next.display).toEqual({ instanceId: "display-next" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
