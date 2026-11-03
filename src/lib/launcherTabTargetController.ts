import { launcherTabIntent, type LauncherTabTarget } from "./launcherTabTarget";
import type { SearchResult } from "./types";

type Input = { target: LauncherTabTarget | null; query: string; inScope: boolean };
type Dependencies = {
  current: () => Input;
  refresh: () => Promise<boolean>;
  catalog: () => SearchResult[];
  activate: (code: string, payload: string, expectedPluginId: string, isCancelled: () => boolean) => Promise<unknown>;
  feedback: (message: string) => void;
};
export function createLauncherTabTargetController(deps: Dependencies) {
  let pending: number | null = null;
  let revision = 0;
  return {
    cancel() { revision += 1; pending = null; },
    async launch() {
      if (pending !== null) { deps.feedback("正在等待 Tab 目标响应…"); return; }
      const input = deps.current();
      if (!input.inScope) return;
      if (!input.target) { deps.feedback("尚未设置 Tab 目标，请选择一个工具。"); return; }
      const generation = ++revision;
      pending = generation;
      const isCancelled = () => {
        const now = deps.current();
        return generation !== revision || !now.inScope || now.query !== input.query
          || now.target?.pluginId !== input.target!.pluginId || now.target.code !== input.target!.code;
      };
      deps.feedback("正在检查 Tab 目标…");
      try {
        const refreshed = await deps.refresh();
        if (isCancelled()) {
          if (generation === revision) deps.feedback("");
          return;
        }
        if (!refreshed) { deps.feedback("无法刷新 Tab 目标，请稍后重试或重新选择工具。"); return; }
        const intent = launcherTabIntent(input.target, deps.catalog(), input.query);
        if (intent.status !== "ready") { deps.feedback(intent.message); return; }
        deps.feedback("");
        await deps.activate(intent.code, intent.payload, intent.expectedPluginId, isCancelled);
        if (generation === revision) deps.feedback("");
      } catch {
        if (!isCancelled()) deps.feedback("Tab 目标未能打开，请检查插件状态并重新选择工具。");
      } finally { if (pending === generation) pending = null; }
    },
  };
}
