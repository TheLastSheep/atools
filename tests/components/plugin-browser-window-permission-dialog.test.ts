import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import PermissionConfirmDialog from "../../src/components/PermissionConfirmDialog.svelte";
import { permissionRequestContext } from "../../src/lib/permissionPresentation";
import type { PendingAgentToolRequest } from "../../src/lib/types";

afterEach(cleanup);

function browserWindowRequest(
  overrides: Partial<PendingAgentToolRequest> = {},
): PendingAgentToolRequest {
  return {
    id: "browser-window-permission",
    run_id: "browser-window-run",
    client_id: "atools-ui",
    tool_name: `atools.host.browser-window.${"0123456789abcdef".repeat(1)}01234567`,
    arguments: { operation: "open", intentId: "a".repeat(64) },
    scopes: ["plugin_window"],
    created_at: "2026-10-23T00:00:00Z",
    ...overrides,
  } as PendingAgentToolRequest;
}

it("uses the private native-window copy and hides the intent payload", () => {
  const request = browserWindowRequest();
  render(PermissionConfirmDialog, {
    request,
    displayName: "Snipaste",
    requestContext: permissionRequestContext({
      kind: "plugin_browser_window",
      pluginName: "Snipaste",
      url: "PRIVATE_URL",
      title: "PRIVATE_TITLE",
    }),
    onallowonce: vi.fn(),
    onallowremember: vi.fn(),
    ondeny: vi.fn(),
  });

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
    "Snipaste 申请创建/管理独立窗口",
  );
  expect(screen.getByText("请求来源").parentElement?.textContent).toContain("Snipaste");
  expect(screen.getByText("仅管理此插件自己的独立窗口")).toBeTruthy();
  expect(screen.getByText(/这不允许管理其他插件、系统或其他应用的窗口/)).toBeTruthy();
  expect(screen.getByText(/拒绝后，请在插件中重新发起操作/)).toBeTruthy();
  expect(document.querySelector(".arguments")).toBeNull();
  expect(document.querySelector(".path-box")).toBeNull();
  expect(document.body.textContent).not.toContain("intentId");
  expect(document.body.textContent).not.toContain("a".repeat(64));
  expect(document.body.textContent).not.toContain("PRIVATE_URL");
  expect(document.body.textContent).not.toContain("PRIVATE_TITLE");
});

it("keeps generic arguments visible when backend context or scopes do not match", () => {
  const request = browserWindowRequest({
    arguments: { operation: "open", intentId: "fallback-intent", url: "PRIVATE_URL" },
    scopes: ["plugin_window", "shell"],
  });
  render(PermissionConfirmDialog, {
    request,
    displayName: "Snipaste",
    requestContext: permissionRequestContext({
      kind: "plugin_browser_window",
      pluginName: "Snipaste",
    }),
    onallowonce: vi.fn(),
    onallowremember: vi.fn(),
    ondeny: vi.fn(),
  });

  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(request.tool_name);
  expect(document.querySelector(".arguments")).not.toBeNull();
  expect(document.body.textContent).toContain("fallback-intent");
  expect(document.body.textContent).toContain("PRIVATE_URL");
  expect(document.body.textContent).not.toContain("仅管理此插件自己的独立窗口");
});
