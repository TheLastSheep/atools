import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, Function>() }));
vi.mock("@tauri-apps/api/core", async (original) => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, fn) => { mocks.events.set(name, fn); return () => mocks.events.delete(name); }) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanel.svelte", async () => ({ default: (await import("./LauncherMediaPluginFixture.svelte")).default }));
const file = { path: "/tmp/private-document.pdf", name: "private-document.pdf", isFile: true, isDirectory: false };
const candidate = { code: "pdf-read", plugin_id: "original-pdf", plugin_name: "文档工具", label: "预览文档", explain: "PDF读取", icon: null, score: 99, match_type: "files", content_search_terms: ["pdf", "preview-alias"] };
let nativeRead: () => Promise<unknown>, fileSearch: () => Promise<unknown>, activation: (args: any) => Promise<unknown>;
beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.events.clear();
    localStorage.clear();
    Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
    localStorage.setItem("atools-settings", JSON.stringify({ autoPaste: "never", showRecentInSearch: false }));
    nativeRead = async () => null;
    fileSearch = async () => ({ files: [file], results: [candidate] });
    activation = async (args) => ({ plugin_id: candidate.plugin_id, plugin_name: candidate.plugin_name, feature_code: args.code, main_url: "index.html", plugin_path: "/fixture", expand_height: 500, payload: args.paths ? [file] : args.dataUrl, entry_type: args.paths ? "files" : "img" });
    mocks.invoke.mockImplementation((command, args = {}) => {
        if (command === "get_setting")
            return Promise.resolve(localStorage.getItem("atools-settings"));
        if (command === "feature_catalog")
            return Promise.resolve([candidate]);
        if (command === "read_launcher_clipboard_media")
            return nativeRead();
        if (command === "search_file_content_features")
            return fileSearch();
        if (command === "search_image_content_features")
            return Promise.resolve([{ ...candidate, match_type: "img" }]);
        if (command === "activate_file_content_feature" || command === "activate_image_content_feature")
            return activation(args);
        if (command === "search_features" || command === "search_local_apps" || command === "list_pending_agent_requests")
            return Promise.resolve([]);
        return Promise.resolve(undefined);
    });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function setup() { render(App, { backgroundServices: false }); const input = screen.getByRole("combobox") as HTMLInputElement; await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true)); return input; }
function paste(input: HTMLInputElement, files: unknown[] = [], text = "") { const e = new Event("paste", { bubbles: true, cancelable: true }); Object.defineProperty(e, "clipboardData", { value: { files, getData: () => text } }); input.dispatchEvent(e); return e; }
function calls(command: string) { return mocks.invoke.mock.calls.filter(([c]) => c === command); }
it("pins confirmed files, filters original plugin aliases locally and activates unchanged paths without content history", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf", size: 9 }]);
    await screen.findByRole("button", { name: "移除固定文件" });
    await screen.findByRole("option", { name: /预览文档/ });
    expect(input.value).toBe("");
    await fireEvent.input(input, { target: { value: "preview-alias" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(calls("search_file_content_features")).toHaveLength(1);
    await fireEvent.click(screen.getByRole("option", { name: /预览文档/ }));
    await screen.findByRole("region", { name: "媒体插件验收" });
    expect(calls("activate_file_content_feature")[0][1]).toEqual({ code: candidate.code, paths: [file.path], expectedPluginId: candidate.plugin_id });
    expect(screen.getByTestId("media-entry-type").textContent).toBe("files");
    expect(screen.getByTestId("media-entry-payload").textContent).toBe(JSON.stringify([file]));
    expect(localStorage.getItem("atools:command-history") ?? "").not.toContain("private-document");
});
it("reads Finder clipboard exactly once on empty paste and rejects an old async answer after typing", async () => {
    const input = await setup();
    let resolve!: (v: unknown) => void;
    nativeRead = () => new Promise(r => resolve = r);
    paste(input);
    await waitFor(() => expect(calls("read_launcher_clipboard_media")).toHaveLength(1));
    await fireEvent.input(input, { target: { value: "new query" } });
    resolve({ kind: "files", files: [file] });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "移除固定文件" })).toBeNull();
    expect(input.value).toBe("new query");
});
it("uses real File bytes for image activation and never adds the dataURL to query/ARIA/history", async () => {
    const input = await setup();
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
    paste(input, [image]);
    await screen.findByRole("button", { name: "移除固定图片" });
    await fireEvent.click(await screen.findByRole("option", { name: /预览文档/ }));
    await screen.findByRole("region", { name: "媒体插件验收" });
    expect(calls("activate_image_content_feature")[0][1]).toEqual({ code: candidate.code, dataUrl: "data:image/png;base64,iVBORw==", expectedPluginId: candidate.plugin_id });
    expect(calls("read_launcher_clipboard_media")).toHaveLength(1);
    expect(calls("read_launcher_clipboard_media")[0][1]).toEqual({ filesOnly: true });
});
it.each(["existing", "selection"])("replaces %s query with Finder files only if native paste insertion still matches", async (mode) => {
    const input = await setup();
    await fireEvent.input(input, { target: { value: "prefix suffix" } });
    input.setSelectionRange(mode === "selection" ? 0 : 6, mode === "selection" ? input.value.length : 6);
    let resolve!: (v: unknown) => void;
    nativeRead = () => new Promise(r => resolve = r);
    const e = paste(input, [], "native text");
    expect(e.defaultPrevented).toBe(false);
    const expected = mode === "selection" ? "native text" : "prefixnative text suffix";
    await fireEvent.input(input, { target: { value: expected } });
    const caret = mode === "selection" ? 11 : 17;
    input.setSelectionRange(caret, caret);
    resolve({ kind: "files", files: [file] });
    await screen.findByRole("button", { name: "移除固定文件" });
    expect(input.value).toBe("");
    expect(calls("read_launcher_clipboard_media")).toHaveLength(1);
});
it("keeps default selected plain text paste unchanged when native probe returns null", async () => {
    const input = await setup();
    await fireEvent.input(input, { target: { value: "old text" } });
    input.select();
    const e = paste(input, [], "replacement");
    expect(e.defaultPrevented).toBe(false);
    await fireEvent.input(input, { target: { value: "replacement" } });
    input.setSelectionRange(11, 11);
    await new Promise(r => setTimeout(r, 20));
    expect(input.value).toBe("replacement");
    expect(screen.queryByRole("button", { name: /移除固定/ })).toBeNull();
    expect(calls("read_launcher_clipboard_media")).toHaveLength(1);
});
it.each(["selection", "composition", "blur"])("does not replace subsequent %s changes with a pending native answer", async (change) => {
    const input = await setup();
    await fireEvent.input(input, { target: { value: "old" } });
    input.setSelectionRange(3, 3);
    let resolve!: (v: unknown) => void;
    nativeRead = () => new Promise(r => resolve = r);
    paste(input, [], " appended");
    await fireEvent.input(input, { target: { value: "old appended" } });
    input.setSelectionRange(12, 12);
    if (change === "selection")
        input.setSelectionRange(0, 3);
    else if (change === "composition")
        await fireEvent.compositionStart(input);
    else
        await fireEvent.blur(window);
    resolve({ kind: "files", files: [file] });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "移除固定文件" })).toBeNull();
    expect(input.value).toBe("old appended");
});
it.each(["Backspace", "Delete"])("clears fixed media with %s without restoring paths into the query", async (key) => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("button", { name: "移除固定文件" });
    await fireEvent.keyDown(input, { key });
    expect(screen.queryByRole("button", { name: "移除固定文件" })).toBeNull();
    expect(input.value).toBe("");
});
it("clears filter then media then hides on Escape and rejects old catalog responses", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("option", { name: /预览文档/ });
    await fireEvent.input(input, { target: { value: "preview-alias" } });
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "移除固定文件" })).toBeTruthy();
    let resolve!: (v: unknown) => void;
    fileSearch = () => new Promise(r => resolve = r);
    mocks.events.get("builtin-plugins-loaded")!({});
    await waitFor(() => expect(calls("search_file_content_features")).toHaveLength(2));
    await fireEvent.keyDown(input, { key: "Escape" });
    resolve({ files: [file], results: [candidate] });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "移除固定文件" })).toBeNull();
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(calls("hide_main_window")).toHaveLength(1);
});
it("rejects stale activation after fixed files are replaced and retains usable retry errors", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("option", { name: /预览文档/ });
    let resolve!: (v: unknown) => void;
    activation = () => new Promise(r => resolve = r);
    await fireEvent.click(screen.getByRole("option", { name: /预览文档/ }));
    await waitFor(() => expect(calls("activate_file_content_feature")).toHaveLength(1));
    await fireEvent.click(screen.getByRole("button", { name: "移除固定文件" }));
    resolve({ plugin_id: candidate.plugin_id, feature_code: candidate.code, payload: [file], entry_type: "files", main_url: "index.html", plugin_path: "/fixture", expand_height: 500 });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "媒体插件验收" })).toBeNull();
});
it("keeps original plugin candidate and builtin open/reveal actions together", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("option", { name: /预览文档/ });
    const open = screen.getByRole("option", { name: /打开粘贴文件/ });
    expect(screen.getByRole("option", { name: /在 Finder 中显示/ })).toBeTruthy();
    await fireEvent.click(open);
    expect(calls("call_agent_tool")[0][1]).toEqual({ name: "open_or_reveal_path", arguments: { path: file.path, reveal: false }, clientId: "atools-ui", confirmed: false });
});
it("shows activation failures and lets the same fixed files retry without losing their payload", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("option", { name: /预览文档/ });
    activation = async () => { throw new Error("removed"); };
    await fireEvent.click(screen.getByRole("option", { name: /预览文档/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "移除固定文件" })).toBeTruthy();
    activation = async (args) => ({ plugin_id: candidate.plugin_id, plugin_name: candidate.plugin_name, feature_code: args.code, payload: [file], entry_type: "files", main_url: "index.html", plugin_path: "/fixture", expand_height: 500 });
    await fireEvent.click(screen.getByRole("option", { name: /预览文档/ }));
    await screen.findByRole("region", { name: "媒体插件验收" });
    expect(calls("activate_file_content_feature")).toHaveLength(2);
});
it("supersedes a pending clipboard probe on page change, and never revives it on return", async () => {
    const input = await setup();
    let resolve!: (v: unknown) => void;
    nativeRead = () => new Promise(r => resolve = r);
    paste(input);
    await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    resolve({ kind: "files", files: [file] });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "移除固定文件" })).toBeNull();
});
it("never decodes a full pasted image to build its token and keeps payload out of attributes/storage", async () => {
    const input = await setup();
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
    paste(input, [image]);
    await screen.findByRole("button", { name: "移除固定图片" });
    expect(input.value).toBe("");
    expect(document.querySelector('img[src^="data:image"]')).toBeNull();
    for (const node of document.querySelectorAll("[aria-label],[title]")) {
        expect(node.getAttribute("aria-label") ?? "").not.toContain("base64");
        expect(node.getAttribute("title") ?? "").not.toContain("base64");
    }
    expect(JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))).not.toContain("base64");
});
it("clears media and cancels pending activation when the launcher becomes hidden", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("option", { name: /预览文档/ });
    let resolve!: (v: unknown) => void;
    activation = () => new Promise(r => resolve = r);
    await fireEvent.click(screen.getByRole("option", { name: /预览文档/ }));
    await waitFor(() => expect(calls("activate_file_content_feature")).toHaveLength(1));
    try {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        await fireEvent(document, new Event("visibilitychange"));
        resolve({ plugin_id: candidate.plugin_id, feature_code: candidate.code, payload: [file], entry_type: "files", main_url: "index.html", plugin_path: "/fixture", expand_height: 500 });
        await new Promise(r => setTimeout(r, 20));
        expect(screen.queryByRole("button", { name: "移除固定文件" })).toBeNull();
        expect(screen.queryByRole("region", { name: "媒体插件验收" })).toBeNull();
    }
    finally {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
});
it("does not read stale presentation state or resize after a pending media result outlives App", async () => {
    const input = await setup();
    let resolveSearch!: (value: unknown) => void;
    fileSearch = () => new Promise(resolve => { resolveSearch = resolve; });
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await waitFor(() => expect(resolveSearch).toBeTypeOf("function"));

    const resizeCallsBeforeUnmount = calls("expand_window").length;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
        cleanup();
        resolveSearch({ files: [file], results: [candidate] });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(warning.mock.calls.flat().join(" ")).not.toContain("derived_inert");
        expect(calls("expand_window")).toHaveLength(resizeCallsBeforeUnmount);
    } finally {
        warning.mockRestore();
    }
});

it("rejects owner changes on the media activation path", async () => {
    const input = await setup();
    paste(input, [{ name: file.name, path: file.path, type: "application/pdf" }]);
    await screen.findByRole("option", { name: /预览文档/ });
    activation = async (args) => ({ plugin_id: "different-owner", feature_code: args.code, payload: [file], entry_type: "files", main_url: "index.html", plugin_path: "/fixture", expand_height: 500 });
    await fireEvent.click(screen.getByRole("option", { name: /预览文档/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("来源已变化");
    expect(screen.queryByRole("region", { name: "媒体插件验收" })).toBeNull();
});
it("prefers confirmed Finder PNG files over its browser image representation using a files-only native read", async () => {
    const input = await setup();
    nativeRead = async () => ({ kind: "files", files: [file] });
    const image = new File([new Uint8Array([137, 80, 78, 71])], "finder.png", { type: "image/png" });
    paste(input, [image]);
    await screen.findByRole("button", { name: "移除固定文件" });
    await screen.findByRole("option", { name: /预览文档/ });
    expect(calls("read_launcher_clipboard_media")).toHaveLength(1);
    expect(calls("read_launcher_clipboard_media")[0][1]).toEqual({ filesOnly: true });
    expect(calls("search_image_content_features")).toHaveLength(0);
    expect(calls("search_file_content_features")[0][1]).toEqual({ paths: [file.path] });
});
it("recovers missing browser file paths using a native clipboard file read and ignores webkitRelativePath", async () => {
    const input = await setup();
    nativeRead = async () => ({ kind: "files", files: [file] });
    paste(input, [{ name: "browser.pdf", type: "application/pdf", webkitRelativePath: "upload/browser.pdf" }]);
    await screen.findByRole("option", {name:/预览文档/});
    expect(calls("read_launcher_clipboard_media")).toHaveLength(1);
    expect(calls("read_launcher_clipboard_media")[0][1]).toBeUndefined();
    expect(calls("search_file_content_features")[0][1]).toEqual({ paths: [file.path] });
});
it("shows a removable neutral token during asynchronous media intake and rejects its late reply after removal", async () => {
    const input = await setup();
    let resolve!: (v: unknown) => void;
    nativeRead = () => new Promise(r => resolve = r);
    const image = new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
    paste(input, [image]);
    const remove = await screen.findByRole("button", { name: "移除固定图片" });
    expect(screen.getByText("正在读取图片")).toBeTruthy();
    await fireEvent.click(remove);
    resolve(null);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "移除固定图片" })).toBeNull();
    expect(calls("search_image_content_features")).toHaveLength(0);
});
it.each(["empty","multiline"])("accepts Finder media over selected text when browser transfer text is %s",async kind=>{
 const input=await setup();await fireEvent.input(input,{target:{value:"before selected after"}});input.setSelectionRange(7,15);let resolve!:(v:unknown)=>void;nativeRead=()=>new Promise(r=>resolve=r);paste(input,[],kind==="empty"?"":"first\r\nsecond");
 if(kind==="multiline"){await fireEvent.input(input,{target:{value:"before firstsecond after"}});input.setSelectionRange(18,18);}
 resolve({kind:"files",files:[file]});await screen.findByRole("option",{name:/预览文档/});expect(input.value).toBe("");expect(calls("search_file_content_features")[0][1]).toEqual({paths:[file.path]});
});
