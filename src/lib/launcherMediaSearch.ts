import { FEATURE_SEARCH_TIMEOUT_MS } from "./launcherSearch";
import { normalizeSearchText, prepareSearchMatchCandidate, searchMatchForPreparedQuery, type PreparedSearchMatchCandidate } from "./searchMatch";
import { pasteResultsForItems, type PastedItem } from "./pasteIntake";
import { launcherMediaPastedItems, launcherMediaSummary, launcherMediaWithinBudget, MEDIA_LIMIT_MESSAGE, type LauncherFile, type LauncherMediaContent, type LauncherMediaInput } from "./launcherMediaContext";
import type { RemoteSearchStatus, SearchFeedback } from "./searchFeedback";
import type { SearchResult } from "./types";
export type LauncherMediaSearchState = {
    content: LauncherMediaContent | null;
    intakeKind: "files" | "img" | null;
    summary: string;
    filter: string;
    results: SearchResult[];
    pastedItems: PastedItem[];
    status: RemoteSearchStatus;
    error: string;
    generation: number;
};
export const emptyLauncherMediaSearchState = (): LauncherMediaSearchState => ({ content: null, intakeKind: null, summary: "", filter: "", results: [], pastedItems: [], status: "idle", error: "", generation: 0 });
type Options = {
    searchFiles: (paths: string[]) => Promise<{
        files: LauncherFile[];
        results: SearchResult[];
    }>;
    searchImage: () => Promise<SearchResult[]>;
    available: () => boolean;
    isActive: () => boolean;
    onUpdate: (state: LauncherMediaSearchState) => void;
};
/** Media bodies stay in memory. One native query owns each generation; filtering never re-reads the clipboard. */
export function createLauncherMediaSearch(options: Options) {
    let state = emptyLauncherMediaSearchState(), disposed = false, intakeRevision = 0;
    let prepared: {
        result: SearchResult;
        candidate: PreparedSearchMatchCandidate;
    }[] = [], stopWaiting: (() => void) | undefined;
    const publish = (patch: Partial<LauncherMediaSearchState>) => {
        state = { ...state, ...patch };
        if (!disposed)
            options.onUpdate(state);
    };
    const current = (generation: number) => !disposed && state.generation === generation && options.isActive();
    function filterResults(value: string) {
        const query = normalizeSearchText(value);
        if (!query)
            return prepared.map(p => p.result);
        return prepared.flatMap(({ result, candidate }, index) => { const match = searchMatchForPreparedQuery(query, candidate); return match ? [{ result, score: match.score, index }] : []; }).sort((a, b) => b.score - a.score || a.index - b.index).map(p => p.result);
    }
    function clear() { intakeRevision++; stopWaiting?.(); stopWaiting = undefined; prepared = []; publish({ ...emptyLauncherMediaSearchState(), generation: state.generation + 1 }); }
    async function load(input: LauncherMediaInput, filter: string) {
        intakeRevision++;
        stopWaiting?.();
        stopWaiting = undefined;
        const generation = state.generation + 1;
        prepared = [];
        const content: LauncherMediaContent = input.kind === "files" ? { ...input, files: [] } : input;
        publish({ content, intakeKind: null, summary: input.kind === "files" ? `${input.paths.length} 个文件` : "图片", filter, results: [], pastedItems: [], status: "searching", error: "", generation });
        if (!options.available()) {
            publish({ status: "unavailable", error: "请在桌面应用中匹配处理此内容的插件。" });
            return;
        }
        try {
            const value = await new Promise<{
                files: LauncherFile[];
                results: SearchResult[];
            }>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("timeout")), FEATURE_SEARCH_TIMEOUT_MS);
                stopWaiting = () => { clearTimeout(timeout); resolve({ files: [], results: [] }); };
                Promise.resolve().then(() => input.kind === "files" ? options.searchFiles(input.paths) : options.searchImage().then(results => ({ files: [], results }))).then(resolve, reject).finally(() => clearTimeout(timeout));
            });
            if (!current(generation))
                return;
            stopWaiting = undefined;
            const confirmed: LauncherMediaContent = input.kind === "files" ? { ...input, files: value.files } : input;
            if (input.kind === "files" && (value.files.length !== input.paths.length || value.files.some((file, index) => file.path !== input.paths[index] || (!file.isFile && !file.isDirectory))))
                throw new Error("文件状态已变化，请重新粘贴。");
            const items = launcherMediaPastedItems(confirmed), identities = new Set<string>();
            const pluginResults = (Array.isArray(value.results) ? value.results : []).filter(result => {
                if (result.match_type !== input.kind || !result.plugin_id || !result.code)
                    return false;
                const identity = JSON.stringify([result.plugin_id, result.code]);
                if (identities.has(identity))
                    return false;
                identities.add(identity);
                return true;
            });
            prepared = [...pluginResults, ...pasteResultsForItems(items)].map(result => ({ result, candidate: prepareSearchMatchCandidate({ text: result.label, extraText: `${result.plugin_name} ${result.explain}`, aliases: result.content_search_terms?.filter(term => typeof term === "string") ?? [] }) }));
            publish({ content: confirmed, summary: launcherMediaSummary(confirmed), pastedItems: items, results: filterResults(state.filter), status: "ready", error: "" });
        }
        catch (error) {
            if (current(generation)) {
                stopWaiting = undefined;
                publish({ results: [], pastedItems: [], status: "error", error: String(error).includes("MEDIA_MATCH_WORK_BUDGET") ? "文件匹配量超过预算，请减少选择的文件或启用的文件规则后重试。" : "内容匹配暂不可用，请检查文件或图片后重新粘贴。" });
            }
        }
    }
    return {
        pin(input: LauncherMediaInput) {
            if (!launcherMediaWithinBudget(input)) {
                publish({ error: MEDIA_LIMIT_MESSAGE });
                return false;
            }
            void load(input, "");
            return true;
        },
        filter(value: string) {
            if (state.content !== null)
                publish({ filter: value, results: filterResults(value) });
        }, clear,
        refresh() {
            intakeRevision++;
            if (state.content !== null)
                void load(state.content, state.filter);
        }, generation: () => state.generation, isCurrent: (generation: number) => current(generation),
        beginIntake: (kind?: "files" | "img") => {
            const revision = ++intakeRevision;
            if (kind)
                publish({ intakeKind: kind, results: [], status: "searching", error: "" });
            return revision;
        }, cancelIntake: () => {
            intakeRevision++;
            if (state.intakeKind !== null)
                publish({ intakeKind: null, status: "idle" });
        }, isIntakeCurrent: (revision: number) => !disposed && intakeRevision === revision && options.isActive(),
        reportIntakeError(message: string) { publish({ intakeKind: null, error: message }); }, dispose() { disposed = true; clear(); },
    };
}
export function launcherMediaSearchFeedback(state: LauncherMediaSearchState): SearchFeedback {
    if (state.status === "searching")
        return { mode: "loading", title: "正在匹配内容处理命令", hint: "只显示可处理固定内容的插件", showSpinner: true };
    if (state.status === "error" || state.status === "unavailable")
        return { mode: "error", title: "内容匹配暂不可用", hint: state.error, showSpinner: false };
    if (state.results.length)
        return { mode: "none", title: "", hint: "", showSpinner: false };
    return { mode: "empty", title: state.filter.trim() ? "没有符合筛选条件的处理命令" : "没有插件可以处理此内容", hint: state.filter.trim() ? "试试插件名称或命令别名，或清除筛选条件" : "可重新粘贴，或启用支持此内容的插件", showSpinner: false };
}
