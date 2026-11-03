import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import PermissionPromptHost from "../../src/components/PermissionPromptHost.svelte";
import { createPermissionHarnessBackend } from "./permissionHarnessBackend";

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ""; });

async function setup() {
  const backend = createPermissionHarnessBackend();
  document.body.innerHTML = '<input id="search" aria-label="搜索"><div id="fixture"></div>';
  document.getElementById("search")!.focus();
  component = mount(PermissionPromptHost, { target: document.getElementById("fixture")!, props: { invoke: backend.invoke, listen: backend.listen } });
  await tick();
  return backend;
}

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;

describe("real permission dialog", () => {
  it("focuses deny, traps Tab and owns Escape without activating the underlying launcher", async () => {
    const backend = await setup();
    const escaped = vi.fn(); window.addEventListener("keydown", escaped);
    backend.add("first", true); backend.add("second");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    await vi.waitFor(() => expect(document.querySelector("h2")?.textContent).toBe("示例插件 · first 请求访问本机"));
    expect(document.querySelector(".request-time")?.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(document.querySelector(".request-time")?.getAttribute("title")).toBe("2026-10-15T12:00:00Z");
    expect(document.querySelector(".summary")?.textContent).not.toContain("可能执行");
    expect(document.activeElement).toBe(button("拒绝"));
    expect(document.querySelector('[role="status"]')?.textContent).toContain("共 2 个请求");
    button("允许并记住").focus();
    button("允许并记住").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toBe("技术详情");
    button("拒绝").focus();
    button("拒绝").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector("h2")?.textContent).toContain("second"));
    expect(escaped).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button("拒绝"));
    backend.cancel("second");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.activeElement?.id).toBe("search");
    window.removeEventListener("keydown", escaped);
  });

  it("keeps busy actions disabled, prevents Escape cancellation and removes an externally cancelled request", async () => {
    const backend = await setup();
    backend.add("first", true);
    await vi.waitFor(() => expect(button("允许一次")).toBeDefined());
    const release = backend.hold("call_agent_tool");
    button("允许一次").click(); await tick();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true"));
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].every((item) => item.disabled)).toBe(true);
    document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(backend.calls.some((call) => call.command === "dismiss_pending_agent_request")).toBe(false);
    backend.cancel("first");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    release(); await tick();
    expect(document.activeElement?.id).toBe("search");
  });

  it("announces an approval error, enables retry and denies through the same backend request", async () => {
    const backend = await setup();
    backend.add("first");
    await vi.waitFor(() => expect(button("允许并记住")).toBeDefined());
    backend.failNext("grant_agent_tool");
    button("允许并记住").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("数据库暂时繁忙"));
    expect(button("拒绝").disabled).toBe(false);
    button("拒绝").click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(backend.calls.find((call) => call.command === "dismiss_pending_agent_request")?.args?.requestId).toBe("first");
  });

  it("shows the plugin AI explanation without exposing capability hashes or private request arguments", async () => {
    const backend = await setup();
    const request = backend.add("ai-request");
    request.tool_name = "atools.plugin.ai.0123456789abcdef01234567";
    request.scopes = ["network"];
    request.arguments = { operation: "execute", requestId: "private-ai-request" };
    backend.runs.get(request.run_id!)!.capabilityId = request.tool_name;
    backend.runs.get(request.run_id!)!.input = request.arguments;
    backend.contexts.set(request.id, { kind: "plugin_ai", pluginName: "写作助手" });

    await vi.waitFor(() => expect(document.querySelector("h2")?.textContent).toBe("写作助手 请求使用已配置的 AI"));
    const dialogText = document.querySelector('[role="dialog"]')!.textContent ?? "";
    expect(dialogText).toContain("对话内容和图片会发送到你已配置的 AI 服务");
    expect(dialogText).toContain("执行历史不包含 API 密钥或提示词正文");
    expect(dialogText).not.toContain("atools.plugin.ai.");
    expect(dialogText).not.toContain("private-ai-request");
    expect(document.querySelector(".technical-details")).toBeNull();

    button("允许一次").click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(backend.calls.find((call) => call.command === "call_agent_tool")?.args?.runId).toBe(request.run_id);
  });
});
