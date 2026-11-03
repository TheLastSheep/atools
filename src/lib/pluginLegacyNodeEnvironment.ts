import { nodeModuleBridgeScript } from "./nodeModuleBridge";
import type { TaskRun } from "./types";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type OpenResult = { sessionId?: string; runId?: string; tool?: string; permission_required?: boolean; error?: string };

/** Owns one generation-bound Node session and its host module environment. */
export function createPluginLegacyNodeEnvironment(
  invoke: Invoke,
  pluginId: string,
  isCurrent: () => boolean,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 200)),
  fixedInstanceId?: string,
) {
  const instanceId = fixedInstanceId ?? crypto.randomUUID();
  let closed = false;
  let requested = false;
  let closing: Promise<void> | undefined;

  function closeStrict() {
    closed = true;
    if (requested && !closing) closing = invoke<void>("close_legacy_node", { pluginId, instanceId }).then(() => undefined);
    return closing ?? Promise.resolve();
  }

  function close() {
    const completion = closeStrict();
    void completion.catch(error => console.warn("[Plugin runtime] Node cleanup failed", error));
    return completion.catch(() => undefined);
  }

  function assertCurrent() {
    if (closed || !isCurrent()) {
      void close();
      throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
    }
  }

  async function awaitSession(opened: OpenResult): Promise<string> {
    if (opened.sessionId) return opened.sessionId;
    if (!opened.permission_required || !opened.runId || !opened.tool) {
      throw new Error(opened.error || "无法开启插件的 Node 运行环境");
    }
    while (true) {
      assertCurrent();
      await wait();
      assertCurrent();
      const run: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId });
      assertCurrent();
      if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool
        || run.initiator.clientId !== "atools-ui") throw new Error("插件授权任务已失效，请重新打开插件");
      if (run.status === "succeeded") {
        const output = run.output as OpenResult | null;
        if (!output?.sessionId) throw new Error("插件授权完成，但未建立 Node 会话");
        return output.sessionId;
      }
      if (run.status === "failed" || run.status === "cancelled" || run.status === "partial") {
        throw new Error(run.summary || "插件 Node 授权未完成");
      }
    }
  }

  async function prepare(selectedPreload?: string): Promise<string> {
    try {
      assertCurrent();
      requested = true;
      const opened = await invoke<OpenResult>("prepare_legacy_node", { pluginId, instanceId,
        ...(selectedPreload === undefined ? {} : { selectedPreload }),
      });
      assertCurrent();
      const sessionId = await awaitSession(opened);
      assertCurrent();
      const config = await invoke<{ endpoint: string }>("get_legacy_node_session", { sessionId });
      assertCurrent();
      const bridge = nodeModuleBridgeScript(config);
      return `<script data-atools-node-modules>\nwindow.__atoolsNodeModuleRequire = ${bridge};\nwindow.require = window.__atoolsNodeModuleRequire;\nwindow.process = window.require('process');\nwindow.Buffer = window.require('buffer').Buffer;\nif (!window.setImmediate) window.setImmediate = function(fn) { return setTimeout(fn, 0); };\nif (!window.clearImmediate) window.clearImmediate = clearTimeout;\n</script>`;
    } catch (error) {
      await close();
      throw error;
    }
  }

  return { prepare, close, closeStrict };
}
