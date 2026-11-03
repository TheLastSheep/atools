import type { TaskRun } from "./types";

export type PluginNativeBrowserWindowPreparedIntent = {
  intentId: string;
  runId: string;
  permission_required: boolean;
  client_id: string;
  tool: string;
  arguments: unknown;
  error?: string;
};

export type PluginNativeBrowserWindowInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Operation = "open" | "action";
// Rust TaskRun::new persists IDs as `run-${generate_rev()}` (UUID v4).
const TASK_RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const toolPattern = /^atools\.host\.browser-window\.[0-9a-f]{24}$/;
const failure = (code: string) => Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_${code}`);

export async function pluginNativeBrowserWindowTool(pluginId: string) {
  if (!pluginId || pluginId.length > 256 || !globalThis.crypto?.subtle) throw failure("TOOL_ID_UNAVAILABLE");
  const bytes = new TextEncoder().encode(pluginId);
  if (bytes.byteLength > 256) throw failure("TOOL_ID_UNAVAILABLE");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const suffix = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 24);
  return `atools.host.browser-window.${suffix}`;
}

function exactInput(value: unknown, operation: Operation, intentId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2 && input.operation === operation && input.intentId === intentId;
}

export function validatePluginNativeBrowserWindowIntent(
  value: unknown,
  operation: Operation,
  intentId: string,
  expectedTool: string,
): PluginNativeBrowserWindowPreparedIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("INVALID_TASK");
  const opened = value as Record<string, unknown>;
  if (typeof opened.intentId !== "string" || opened.intentId !== intentId
    || typeof opened.runId !== "string" || !TASK_RUN_ID.test(opened.runId)
    || opened.client_id !== "atools-ui" || opened.tool !== expectedTool || !toolPattern.test(String(opened.tool))
    || typeof opened.permission_required !== "boolean" || !exactInput(opened.arguments, operation, intentId)) {
    throw failure("INVALID_TASK_BINDING");
  }
  return opened as PluginNativeBrowserWindowPreparedIntent;
}

function taskMatches(run: TaskRun | null, opened: PluginNativeBrowserWindowPreparedIntent,
  operation: Operation, intentId: string) {
  return Boolean(run && run.id === opened.runId && run.capabilityId === opened.tool
    && run.initiator?.type === "human" && run.initiator?.clientId === opened.client_id
    && exactInput(run.input, operation, intentId));
}

export async function waitForPluginNativeBrowserWindowRun(options: {
  opened: PluginNativeBrowserWindowPreparedIntent;
  operation: Operation;
  intentId: string;
  invoke: PluginNativeBrowserWindowInvoke;
  assertCurrent: () => void;
  listen?: <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
  timeoutMs?: number;
}) {
  const { opened, operation, intentId, invoke, assertCurrent } = options;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000);
  if (!TASK_RUN_ID.test(opened.runId) || !exactInput(opened.arguments, operation, intentId)) throw failure("INVALID_TASK_BINDING");
  let wake: (() => void) | undefined, unlisten: (() => void) | undefined, disposed = false;
  let eventSeen = false;
  const attach = options.listen?.<string>("task-run-updated", event => {
    if (!disposed && event.payload === opened.runId) { eventSeen = true; wake?.(); }
  });
  if (attach) unlisten = await attach.catch(() => undefined);
  function dispose() { disposed = true; unlisten?.(); unlisten = undefined; }
  const started = Date.now();
  try {
    while (Date.now() - started < timeoutMs) {
      assertCurrent();
      const run = await invoke<TaskRun | null>("get_task_run", { id: opened.runId });
      assertCurrent();
      if (!taskMatches(run, opened, operation, intentId)) throw failure("TASK_BINDING_MISMATCH");
      if (run!.status === "succeeded") return run!;
      if (["failed", "cancelled", "partial"].includes(run!.status)) throw failure("PERMISSION_DENIED");
      const delay = eventSeen ? 0 : 1_000;
      eventSeen = false;
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (timer !== undefined) clearTimeout(timer);
          if (wake === finish) wake = undefined;
          resolve();
        };
        wake = finish;
        if (delay === 0) finish();
        else timer = setTimeout(finish, delay);
      });
    }
    throw failure("PERMISSION_TIMEOUT");
  } finally { dispose(); }
}

