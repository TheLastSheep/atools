import { invoke, permissionDialog } from "./nativePublishedPluginCommon";
import type { PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";

type NodeAuthorizationContext = Pick<PublishedScenarioContext, "profile" | "check" | "until">;

export function matchesPublishedNodeRequest(title: string, pluginTitle: string, value: unknown): boolean {
  if (!title.includes(pluginTitle) || !title.includes("请求访问本机") || !Array.isArray(value) || value.length !== 1) return false;
  const request = value[0];
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const item = request as Record<string, unknown>;
  return typeof item.tool_name === "string" && /^legacy_node_[a-f0-9]{64}$/.test(item.tool_name)
    && item.client_id === "atools-ui";
}

export async function approvePublishedNodePermission(context: NodeAuthorizationContext): Promise<RuntimeState> {
  await context.until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    if (!title.includes(context.profile.title) || !title.includes("请求访问本机")) return null;
    const pending = await invoke<unknown>("list_pending_agent_requests");
    return matchesPublishedNodeRequest(title, context.profile.title, pending) ? true : null;
  }, "Exact Node capability did not reach the real permission UI; other permission types are never approved as Node");
  const waiting = await invoke<RuntimeState>("native_published_runtime_state");
  context.check(waiting.legacySessions === 0 && waiting.pendingRequests === 1,
    "Node preload waits at the real one-time permission gate before creating a session");
  const allowOnce = [...(permissionDialog()?.querySelectorAll<HTMLButtonElement>("button") || [])]
    .find(button => button.textContent?.trim() === "允许一次");
  context.check(allowOnce, "Production permission UI offers a one-time approval");
  if (!allowOnce) throw Error("Production permission UI omitted the one-time Node approval");
  allowOnce.click();
  return waiting;
}

export async function waitForPublishedNodeSession(context: NodeAuthorizationContext): Promise<RuntimeState> {
  const active = await context.until(async () => {
    const value = await invoke<RuntimeState>("native_published_runtime_state");
    return value.legacySessions > 0 && value.legacyTransport ? value : null;
  }, "Approved Node preload did not create the isolated legacy session");
  context.check(active.legacySessions > 0 && active.legacyTransport,
    "Node-dependent preload runs only after real permission and owns an active Node session");
  return active;
}

export type DeepReadPermissionKind = "data" | "dialog" | "paths" | "display" | "node" | "ready" | "unexpected" | null;

export function classifyDeepReadPermission(title: string, hasDialog: boolean, hasFrame: boolean, pluginTitle: string): DeepReadPermissionKind {
  if (!hasDialog) return hasFrame ? "ready" : null;
  if (!title.trim()) return null;
  if (!title.includes(pluginTitle)) return "unexpected";
  if (title.includes("请求访问自己的数据")) return "data";
  if (title.includes("请求打开文件选择窗口")) return "dialog";
  if (title.includes("请求读取常用目录路径")) return "paths";
  if (title.includes("请求读取显示器信息")) return "display";
  if (title.includes("请求访问本机")) return "node";
  return "unexpected";
}
