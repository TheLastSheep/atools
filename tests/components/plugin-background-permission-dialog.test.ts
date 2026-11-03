import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import PermissionConfirmDialog from "../../src/components/PermissionConfirmDialog.svelte";
import { permissionRequestContext } from "../../src/lib/permissionPresentation";
import type { PendingAgentToolRequest } from "../../src/lib/types";

afterEach(cleanup);

function request(overrides: Partial<PendingAgentToolRequest> = {}): PendingAgentToolRequest {
  return {
    id: "background-permission", run_id: "background-run", client_id: "atools-ui",
    tool_name: `atools.host.plugin-background.${"a".repeat(24)}.start`,
    arguments: {
      requestId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      pluginId: "snipaste", codeRevision: "b".repeat(64), operation: "start",
    },
    scopes: ["plugin_background"], created_at: "2026-10-23T00:00:00Z", ...overrides,
  };
}

it("renders the native background request as plugin consent and sends the original denial", async () => {
  const pending = request(), deny = vi.fn();
  render(PermissionConfirmDialog, {
    request: pending, displayName: "Snipaste",
    requestContext: permissionRequestContext({ kind: "plugin_background", pluginName: "Snipaste" }),
    onallowonce: vi.fn(), onallowremember: vi.fn(), ondeny: deny,
  });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Snipaste 申请在后台持续运行");
  expect(screen.getByText(/主窗口隐藏时继续运行/)).toBeTruthy();
  expect(screen.getByText(/这些能力仍需单独授权/)).toBeTruthy();
  expect(document.querySelector(".arguments")).toBeNull();
  expect(document.body.textContent).not.toContain("sessionId");
  expect(document.body.textContent).not.toContain("b".repeat(64));
  await fireEvent.click(screen.getByRole("button", { name: /拒绝/ }));
  expect(deny).toHaveBeenCalledOnce();
  expect(deny).toHaveBeenCalledWith(pending);
});

it.each([
  { kind: "tool", overrides: {} },
  { kind: "plugin_background", overrides: { scopes: ["plugin_background", "shell"] } },
  { kind: "plugin_background", overrides: { arguments: { operation: "start", path: "untrusted-path" } } },
  { kind: "plugin_background", overrides: { tool_name: `atools.host.plugin-background.${"a".repeat(24)}.stop` } },
])("does not use private consent copy for a mismatched request %#", ({ kind, overrides }) => {
  const pending = request(overrides);
  render(PermissionConfirmDialog, {
    request: pending, requestContext: permissionRequestContext({ kind, pluginName: "Snipaste" }),
    onallowonce: vi.fn(), onallowremember: vi.fn(), ondeny: vi.fn(),
  });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(pending.tool_name);
  expect(document.querySelector(".arguments")).not.toBeNull();
  expect(document.body.textContent).not.toContain("Snipaste 申请在后台持续运行");
});
