import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));

import {
  approvePublishedNodePermission,
  classifyDeepReadPermission,
  waitForPublishedNodeSession,
} from "./nativePublishedNodeAuthorization";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

const profile = { title: "DeepRead" };
function context(): Pick<PublishedScenarioContext, "profile" | "check" | "until"> {
  return {
    profile: profile as PublishedScenarioContext["profile"],
    check: (ok, label) => { if (!ok) throw Error(label); },
    until: async <T>(read: () => T | Promise<T>) => {
      const value = await read();
      if (value === null || value === undefined || value === false) throw Error("Expected permission predicate was not met");
      return value as NonNullable<T>;
    },
  };
}

function showNodePrompt(title = "DeepRead 请求访问本机") {
  document.body.innerHTML = `<div data-permission-dialog><h2>${title}</h2><button>允许一次</button></div>`;
  return document.querySelector<HTMLButtonElement>("button")!;
}

afterEach(() => {
  document.body.replaceChildren();
  mocks.invoke.mockReset();
});

it("re-approves only the exact Node request when a later activation renews the one-time prompt", async () => {
  const toolName = `legacy_node_${"a".repeat(64)}`;
  let sessionReads = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_pending_agent_requests") return [{ tool_name: toolName, client_id: "atools-ui" }];
    if (command === "native_published_runtime_state") {
      sessionReads += 1;
      return sessionReads % 2 === 1
        ? { legacySessions: 0, pendingRequests: 1 }
        : { legacySessions: 1, legacyTransport: true };
    }
    throw Error(`Unexpected host command: ${command}`);
  });

  let approvals = 0;
  for (let activation = 0; activation < 2; activation++) {
    const button = showNodePrompt();
    button.addEventListener("click", () => { approvals += 1; });
    await approvePublishedNodePermission(context());
    expect(approvals).toBe(activation + 1);
    expect(button.isConnected).toBe(true);
    await waitForPublishedNodeSession(context());
  }
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_pending_agent_requests")).toHaveLength(2);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "native_published_runtime_state")).toHaveLength(4);
});

it("classifies unrelated dialogs as unexpected and never approves them as Node", async () => {
  const button = showNodePrompt("Other Plugin 请求访问本机");
  expect(classifyDeepReadPermission("Other Plugin 请求访问本机", true, false, "DeepRead")).toBe("unexpected");
  expect(classifyDeepReadPermission("Other Plugin 请求访问自己的数据", true, false, "DeepRead")).toBe("unexpected");
  expect(classifyDeepReadPermission("", true, false, "DeepRead")).toBeNull();
  expect(classifyDeepReadPermission("DeepRead 请求访问本机", true, false, "DeepRead")).toBe("node");
  mocks.invoke.mockResolvedValue([]);
  await expect(approvePublishedNodePermission(context())).rejects.toThrow("Expected permission predicate was not met");
  expect(button.isConnected).toBe(true);
  expect(button.textContent).toBe("允许一次");
  expect(mocks.invoke).not.toHaveBeenCalled();
});
