// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportsFixture } from "./plugin-feature-exports-fixture";

const temporary: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "atools-exports-contract-")); temporary.push(root); return root; };
afterEach(() => temporary.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const fixtureFs = (root: string) => ({
  existsSync: (file: string) => path.resolve(file).startsWith(root + path.sep) && fs.existsSync(file),
  readFileSync: (file: string, encoding: BufferEncoding) => {
    if (!path.resolve(file).startsWith(root + path.sep)) throw Error("Fixture file outside selected root");
    return fs.readFileSync(file, encoding);
  },
});
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("complete unchanged original preload graphs over explicit fixture transports", () => {
  it("recent-typora enter/search/select retains real path/itemType and reads only fixture history", async () => {
    const f = exportsFixture(), root = temp();
    const document = path.join(root, "Fixed Note.md"), folder = path.join(root, "Fixed Folder");
    fs.writeFileSync(document, "fixed"); fs.mkdirSync(folder);
    const history = path.join(root, "history.data");
    fs.writeFileSync(history, JSON.stringify({ recentDocument: [{ name: "Fixed Note", path: document, date: 2 }], recentFolder: [{ name: "Fixed Folder", path: folder, date: 1 }] }));
    const child = { once: vi.fn(), unref: vi.fn() }, spawn = vi.fn(() => child);
    f.loadOriginal("ZTools-plugins/plugins/recent-typora/preload.js", { fs: fixtureFs(root), os: { homedir: () => root }, child_process: { spawn } }, { env: { TYPORA_HISTORY_PATH: history } });
    f.bridge.start({ code: "recent-typora", type: "text", payload: "" }); await flush();
    expect(f.latestRows().map((row: any) => row.title)).toEqual(["Fixed Note", "Fixed Folder"]);
    expect(f.api.setSubInput.mock.calls[0][1]).toBe("搜索最近打开的文件或文件夹");
    f.search("Fixed Folder"); expect(f.latestRows().map((row: any) => row.title)).toEqual(["Fixed Folder"]);
    f.command(); await flush();
    expect(spawn).toHaveBeenCalledWith("open", ["-a", "Typora", folder], { detached: true, stdio: "ignore", windowsHide: true });
    expect(child.unref).toHaveBeenCalledOnce(); expect(f.api.outPlugin).toHaveBeenCalledOnce(); expect(f.api.hideMainWindow).toHaveBeenCalledOnce();
  });

  it("bookmarks complete preload/bookmarks/mcp graph echoes delayed payload search and selects original browser+URL", async () => {
    const f = exportsFixture(), root = temp(), spawn = vi.fn();
    for (const [browser, title, url] of [["Google/Chrome", "Fixed Chrome", "https://fixture.invalid/chrome"], ["Microsoft Edge", "Fixed Edge", "https://fixture.invalid/edge"]]) {
      const dir = path.join(root, browser, "Default"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "Bookmarks"), JSON.stringify({ roots: { bookmark_bar: { children: [{ type: "url", name: title, url, date_added: "5" }] } } }));
    }
    f.api.getPath.mockReturnValue(root);
    f.loadOriginal("ZTools-plugins/plugins/bookmarks/preload.js", { fs: fixtureFs(root), child_process: { spawn } }, { env: { HOME: root } });
    f.bridge.start({ code: "search", type: "regex", payload: "Fixed Edge" }); expect(f.latestRows()).toEqual([]);
    f.timers.splice(0).forEach(callback => callback()); await flush();
    expect(f.api.getPath).toHaveBeenCalledWith("appData"); expect(f.api.setSubInputValue).toHaveBeenCalledWith("Fixed Edge");
    expect(f.latestRows().map((row: any) => row.title)).toEqual(["Fixed Edge"]);
    f.command(); await flush();
    expect(f.api.shellOpenExternal).toHaveBeenCalledWith("https://fixture.invalid/edge");
    expect(f.api.hideMainWindow).toHaveBeenCalledWith(false); expect(f.api.outPlugin).toHaveBeenCalledOnce();
    expect(f.api.registerTool).toHaveBeenCalledWith("bookmarks_query", expect.any(Function));
    expect(f.api.onMainPush).toHaveBeenCalledOnce();
  });

  it.each([
    ["copyText", " fixed \n text ", " fixed \n text "],
    ["removeTrim", " fixed \n text ", "fixedtext"],
    ["copyUrl", "Read https://fixture.invalid/a and https://fixture.invalid/b", "https://fixture.invalid/a\r\nhttps://fixture.invalid/b"],
  ])("text-copy complete factory graph %s copies transformed payload and leaves once", async (code, payload, expected) => {
    const f = exportsFixture(); f.loadOriginal("ZTools-plugins/plugins/text-copy/public/preload/services.js");
    f.bridge.start({ code, type: "over", payload }); await flush();
    expect(f.api.copyText.mock.calls).toEqual([[expected]]); expect(f.api.outPlugin).toHaveBeenCalledOnce(); expect(f.api.hideMainWindow).toHaveBeenCalledOnce();
    expect(f.api.showNotification).not.toHaveBeenCalled(); expect(f.api.setSubInput).not.toHaveBeenCalled();
    expect(f.messages.every(message => message.mode === "none")).toBe(true);
  });

  it("text-copy settings list select persists toggled value and updates through callback only", async () => {
    const f = exportsFixture(); f.loadOriginal("ZTools-plugins/plugins/text-copy/public/preload/services.js");
    f.bridge.start({ code: "copyTextSetting", type: "text", payload: "" }); await flush();
    expect(f.latestRows()[0].title).toContain("关"); f.command(); await flush();
    expect(f.latestRows()[0].title).toContain("开"); expect(f.storage.get("text-copy.settings")).toEqual({ notificationEnabled: true });
    expect(f.api.setSubInput).not.toHaveBeenCalled(); expect(f.api.removeSubInput).toHaveBeenCalledOnce();
    f.timers.splice(0).forEach(callback => callback()); expect(f.api.outPlugin).toHaveBeenCalledOnce();
  });
});
