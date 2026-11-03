import { expect, it, vi } from "vitest";
import { createLauncherMediaSearch } from "../../src/lib/launcherMediaSearch";
import { mediaInputFromTransfer, canReadClipboardMedia } from "../../src/lib/launcherMediaIntake";
const file = { path: "/tmp/a.pdf", name: "a.pdf", isFile: true, isDirectory: false };
const candidate = { code: "pdf", plugin_id: "original", plugin_name: "文档工具", label: "读取 PDF", explain: "文档预览", icon: null, score: 99, match_type: "files", content_search_terms: ["文档", "preview"] };
const flush = async () => {
    for (let n = 0; n < 8; n++)
        await Promise.resolve();
};
it("loads original file candidates once, keeps builtins after plugins and filters aliases locally", async () => {
    const searchFiles = vi.fn(async () => ({ files: [file], results: [candidate] }));
    let state: any;
    const c = createLauncherMediaSearch({ searchFiles, searchImage: vi.fn(), available: () => true, isActive: () => true, onUpdate: value => state = value });
    c.pin({ kind: "files", paths: [file.path] });
    await flush();
    expect(state.results[0]).toEqual(candidate);
    expect(state.results.some((r: any) => r.code.startsWith("paste:open:"))).toBe(true);
    c.filter("preview");
    expect(state.results).toEqual([candidate]);
    c.filter("文档工具");
    expect(state.results).toEqual([candidate]);
    expect(searchFiles).toHaveBeenCalledOnce();
    c.dispose();
});
it("rejects stale search after replacement, clearing, and catalog refresh", async () => {
    const loads: Function[] = [];
    let state: any;
    const c = createLauncherMediaSearch({ searchFiles: () => new Promise(resolve => loads.push(resolve)), searchImage: vi.fn(), available: () => true, isActive: () => true, onUpdate: s => state = s });
    c.pin({ kind: "files", paths: [file.path] });
    await flush();
    c.refresh();
    await flush();
    loads[0]({ files: [file], results: [candidate] });
    await flush();
    expect(state.status).toBe("searching");
    c.clear();
    loads[1]({ files: [file], results: [candidate] });
    await flush();
    expect(state.content).toBeNull();
    expect(state.results).toEqual([]);
    c.dispose();
});
it("invalidates pending intake on query changes without discarding pinned media", async () => {
    let state: any;
    const c = createLauncherMediaSearch({ searchFiles: async () => ({ files: [file], results: [candidate] }), searchImage: vi.fn(), available: () => true, isActive: () => true, onUpdate: s => state = s });
    const revision = c.beginIntake();
    expect(c.isIntakeCurrent(revision)).toBe(true);
    c.cancelIntake();
    expect(c.isIntakeCurrent(revision)).toBe(false);
    c.pin({ kind: "files", paths: [file.path] });
    await flush();
    c.filter("pdf");
    expect(state.content.kind).toBe("files");
    c.dispose();
});
it("keeps image bytes and refuses relative file hints", async () => {
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
    const input = await mediaInputFromTransfer({ files: [image] } as unknown as DataTransfer);
    expect(input?.kind).toBe("img");
    expect((input as any).dataUrl).toBe("data:image/png;base64,iVBORw==");
    const relative = Object.assign(new File(["x"], "doc.pdf"), { webkitRelativePath: "folder/doc.pdf" });
    expect(await mediaInputFromTransfer({ files: [relative] } as unknown as DataTransfer)).toBeNull();
});
it("permits explicit media probing for empty and existing noncomposing search", () => {
    const input = document.createElement("input");
    input.dataset.atoolsSearchInput = "true";
    const event = { target: input } as unknown as ClipboardEvent;
    expect(canReadClipboardMedia(event, "")).toBe(true);
    expect(canReadClipboardMedia(event, "existing")).toBe(true);
    input.dataset.atoolsComposing = "true";
    expect(canReadClipboardMedia(event, "")).toBe(false);
});
it("validates whole media budgets without truncating paths or byte bodies", async () => {
    const { launcherMediaWithinBudget } = await import("../../src/lib/launcherMediaContext");
    expect(launcherMediaWithinBudget({ kind: "files", paths: ["relative/doc.pdf"] })).toBe(false);
    expect(launcherMediaWithinBudget({ kind: "files", paths: Array.from({ length: 1001 }, () => "/tmp/a") })).toBe(false);
    expect(launcherMediaWithinBudget({ kind: "files", paths: ["/" + "a".repeat(8192)] })).toBe(false);
    expect(launcherMediaWithinBudget({ kind: "files", paths: Array.from({ length: 1000 }, () => "/" + "a".repeat(263)) })).toBe(false);
    expect(launcherMediaWithinBudget({ kind: "img", dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" })).toBe(false);
    expect(launcherMediaWithinBudget({ kind: "img", dataUrl: "data:image/png;base64," + "A".repeat(8 * 1024 * 1024) })).toBe(false);
    const huge = new File([new Uint8Array(6 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
    await expect(mediaInputFromTransfer({ files: [huge] } as unknown as DataTransfer)).rejects.toThrow("不会截断执行");
});
it("does not accept keyword/image candidates in a file generation and keeps plugin owners distinct", async () => {
    let state: any;
    const c = createLauncherMediaSearch({ searchFiles: async () => ({ files: [file], results: [candidate, { ...candidate }, { ...candidate, plugin_id: "other" }, { ...candidate, code: "keyword", match_type: "exact" }, { ...candidate, code: "image", match_type: "img" }] }), searchImage: vi.fn(), available: () => true, isActive: () => true, onUpdate: s => state = s });
    c.pin({ kind: "files", paths: [file.path] });
    await flush();
    expect(state.results.filter((r: any) => r.match_type === "files").map((r: any) => r.plugin_id)).toEqual(["original", "other"]);
    c.dispose();
});
it("reports failed native matching and supports a clean refresh retry", async () => {
    let state: any, fail = true;
    const c = createLauncherMediaSearch({ searchFiles: async () => {
            if (fail)
                throw new Error("deleted");
            return { files: [file], results: [candidate] };
        }, searchImage: vi.fn(), available: () => true, isActive: () => true, onUpdate: s => state = s });
    c.pin({ kind: "files", paths: [file.path] });
    await flush();
    expect(state.status).toBe("error");
    expect(state.results).toEqual([]);
    fail = false;
    c.refresh();
    await flush();
    expect(state.status).toBe("ready");
    expect(state.results[0]).toEqual(candidate);
    c.dispose();
});
it("shows a bounded work-budget recovery hint without echoing untrusted native details", async () => {
    let state: any;
    const c = createLauncherMediaSearch({ searchFiles: async () => { throw new Error("MEDIA_MATCH_WORK_BUDGET secret /private/input"); }, searchImage: vi.fn(), available: () => true, isActive: () => true, onUpdate: s => state = s });
    c.pin({ kind: "files", paths: [file.path] });
    await flush();
    expect(state.error).toContain("减少选择的文件");
    expect(state.error).not.toContain("secret");
    c.dispose();
});
