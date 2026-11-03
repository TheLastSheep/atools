import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SOURCE_BUILD_CLIENT, SOURCE_BUILD_INSPECT_TOOL, SOURCE_BUILD_TOOL, type SourceBuildRuntime, type SourceBuildServices } from "./pluginSourceBuildProtocol";
import type { ManifestSelection } from "./pluginSourceBuildManifest";
import type { TaskRun } from "./types";

/** Permission approval remains in the shared permission queue. This service never confirms a request. */
export function pluginSourceBuildServices(installed: SourceBuildServices["installed"]): SourceBuildServices {
  let closed = false;
  const pendingReads = new Set<() => void>();
  /** Stops only this read's observation. Native work continues; a late reply cannot settle it again. */
  function readWithDeadline<T>(read: () => Promise<T>, milliseconds: number, timeoutMessage: string): Promise<T> {
    if (closed) return Promise.reject(Error("读取已停止。"));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cancel = () => finish(() => reject(Error("读取已停止。")));
      const timer = setTimeout(() => finish(() => reject(Error(timeoutMessage))), milliseconds);
      pendingReads.add(cancel);
      function finish(action: () => void) {
        if (settled) return;
        settled = true; clearTimeout(timer); pendingReads.delete(cancel); action();
      }
      Promise.resolve().then(() => {
        if (closed) throw Error("读取已停止。");
        return read();
      }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  return {
    inspect: (sourcePath, manifestSelection) => invoke<TaskRun>("start_agent_tool", {
      name: SOURCE_BUILD_INSPECT_TOOL, arguments: { sourcePath, ...(manifestSelection ? { manifestSelection } : {}) },
      clientId: SOURCE_BUILD_CLIENT, confirmed: false,
    }),
    start: (sourcePath, expectedRevision, manifestSelection?: ManifestSelection, expectedManifestSha256?: string) => {
      if ((manifestSelection === undefined) !== (expectedManifestSha256 === undefined)) return Promise.reject(Error("清单选择和摘要必须同时提供。"));
      return invoke<TaskRun>("start_agent_tool", {
        name: SOURCE_BUILD_TOOL, arguments: { sourcePath, expectedRevision, overwrite: true, ...(manifestSelection ? { manifestSelection, expectedManifestSha256 } : {}) },
        clientId: SOURCE_BUILD_CLIENT, confirmed: false,
      });
    },
    read: id => readWithDeadline(() => invoke<TaskRun | null>("get_task_run", { id }), 5_000, "读取任务超时，任务状态尚未确认。可继续读取或在结果中心查看。"),
    runtime: id => readWithDeadline(() => invoke<SourceBuildRuntime>("get_plugin_source_build_state", { id }), 5_000, "读取转换进度超时，任务状态尚未确认。可继续读取或在结果中心查看。"),
    cancel: id => invoke("cancel_task_run", { id }),
    listen: receive => listen<string>("task-run-updated", event => { if (typeof event.payload === "string") receive(event.payload); }),
    installed,
    dispose() { closed = true; for (const cancel of [...pendingReads]) cancel(); },
  };
}
