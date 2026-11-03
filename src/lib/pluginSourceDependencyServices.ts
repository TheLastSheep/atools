import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { SOURCE_DEPENDENCY_CLIENT, SOURCE_DEPENDENCY_TOOLS, type DependencyServices } from "./pluginSourceDependencyProtocol";
import type { TaskRun } from "./types";

/** All three operations enter TaskRun and the existing permission queue; this adapter never confirms. */
export function pluginSourceDependencyServices(): DependencyServices {
  let closed = false;
  const pendingReads = new Set<() => void>();
  function readWithDeadline<T>(read: () => Promise<T>, milliseconds: number): Promise<T> {
    if (closed) return Promise.reject(Error("读取已停止。"));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pendingReads.delete(stop); action();
      };
      const stop = () => finish(() => reject(Error("读取已停止。")));
      const timer = setTimeout(() => finish(() => reject(Error("读取任务超时，任务状态尚未确认。可继续读取或在结果中心查看。"))), milliseconds);
      pendingReads.add(stop);
      Promise.resolve().then(() => {
        if (closed) throw Error("读取已停止。");
        return read();
      }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
  }
  return {
    start: (action, sourcePath, expectedRevision) => {
      const tool = SOURCE_DEPENDENCY_TOOLS[action];
      const args = expectedRevision === undefined ? { sourcePath } : { sourcePath, expectedRevision };
      return invoke<TaskRun>("start_agent_tool", {
        name: tool, arguments: args, clientId: SOURCE_DEPENDENCY_CLIENT, confirmed: false,
      });
    },
    read: id => readWithDeadline(() => invoke<TaskRun | null>("get_task_run", { id }), 5_000),
    cancel: id => invoke<TaskRun>("cancel_task_run", { id }),
    listen: receive => listen<string>("task-run-updated", event => {
      if (typeof event.payload === "string") receive(event.payload);
    }),
    dispose() { closed = true; for (const cancel of [...pendingReads]) cancel(); },
  };
}
