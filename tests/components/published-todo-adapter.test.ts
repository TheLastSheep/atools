import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativePublishedTodoFrameOperations.js?raw";

type Adapter = { caseId: string | null; state: () => Record<string, unknown>; perform: (operation: string, data?: Record<string, unknown>) => unknown };
let adapter: Adapter;
const ALPHA = "ATools Todo synthetic alpha", EDITED = "ATools Todo synthetic alpha edited";
const ownedWindow = window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter; __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; ztools?: unknown; services?: unknown };

beforeEach(() => {
  // Synthetic controls only: original published JS, preload and templates never execute in this test.
  document.body.innerHTML = `<main class="app-shell"><aside><article class="group-item active"><span class="group-title">待处理</span><span class="group-count">1</span></article>
    <article class="group-item"><span class="group-title">ATools synthetic group</span><span class="group-count">0</span></article>
    <button class="sidebar-settings-button" title="设置"></button><button class="add-group-button">添加分组</button>
    <form class="inline-group-composer"><input class="group-create-input"></form><input class="group-edit"></aside>
    <header class="workspace-header"><h1>待处理</h1><button title="新建任务"></button></header><section class="task-panel">
    <article class="task-card active"><input type="checkbox"><span class="task-text">${ALPHA}</span></article>
    <textarea class="task-create-input"></textarea><textarea class="task-edit-input"></textarea></section></main>
    <section class="drawer open" aria-label="设置面板"><label><span>隐藏已完成任务</span><input type="checkbox"></label>
      <label><span>渲染 Markdown</span><input type="checkbox"></label><button class="drawer-close">关闭</button></section>
    <section class="search-picker" aria-label="搜索待办"><input class="task-search-input"><button class="search-result"><span class="result-group">待处理</span><span class="result-text">${ALPHA}</span></button></section>
    <div class="context-menu"><button>详情</button><button>编辑</button><button class="danger">删除</button></div>`;
  const forbidden = () => { throw Error("Fixture attempted a non-DOM plugin operation"); };
  ownedWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "todo-neo";
  ownedWindow.ztools = new Proxy({}, { get: forbidden }); ownedWindow.services = new Proxy({}, { get: forbidden });
  window.eval(source); adapter = ownedWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
});
afterEach(() => {
  document.body.innerHTML = "";
  delete ownedWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; delete ownedWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__;
  delete ownedWindow.ztools; delete ownedWindow.services;
});

it("reads DOM state and does not enter plugin services or data APIs", () => {
  expect(adapter.caseId).toBe("todo-neo");
  expect(adapter.state()).toMatchObject({ mainPage: true, activeGroup: "待处理", disabledWindowControls: 0,
    tasks: [{ text: ALPHA, completed: false, done: false, active: true }],
    groups: [{ title: "待处理", active: true, pendingCount: "1" }, { title: "ATools synthetic group", active: false, pendingCount: "0" }],
    searchResults: [{ text: ALPHA, group: "待处理" }] });
});
it("binds the same bounded DOM operations to the exact converted Todo case and rejects unknown cases", () => {
  ownedWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-todo-neo-source";
  expect(adapter.caseId).toBe("converted-todo-neo-source");
  expect(adapter.state().mainPage).toBe(true);
  adapter.perform("set-task", { value: ALPHA });
  expect(document.querySelector<HTMLTextAreaElement>("textarea.task-create-input")!.value).toBe(ALPHA);
  ownedWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-other-source";
  expect(adapter.caseId).toBeNull();
  expect(() => adapter.perform("set-task", { value: ALPHA })).toThrow(/Unapproved/);
});
it("does not mistake the original permanently mounted closed drawer for an open panel", () => {
  document.querySelector(".drawer")!.classList.remove("open");
  expect(adapter.state().settingsOpen).toBe(false);
  expect(() => adapter.perform("toggle-hide-completed")).toThrow(/DOM missing/);
  document.querySelector(".drawer")!.classList.add("open");
  expect(adapter.state().settingsOpen).toBe(true);
});

it("changes only reviewed input controls and emits bubbling input and commit key events", () => {
  const taskInput = document.querySelector<HTMLTextAreaElement>("textarea.task-create-input")!;
  const edited = document.querySelector<HTMLTextAreaElement>("textarea.task-edit-input")!;
  const input = vi.fn(), commit = vi.fn(), rename = vi.fn();
  taskInput.addEventListener("input", input); taskInput.addEventListener("keydown", commit);
  document.querySelector("input.group-edit")!.addEventListener("keyup", rename);
  adapter.perform("set-task", { value: ALPHA }); adapter.perform("commit-task");
  adapter.perform("set-edit", { value: EDITED });
  adapter.perform("set-group-edit", { value: "ATools renamed group" }); adapter.perform("commit-group-edit");
  expect(taskInput.value).toBe(ALPHA); expect(edited.value).toBe(EDITED);
  expect(input).toHaveBeenCalledOnce(); expect(input.mock.calls[0][0].bubbles).toBe(true);
  expect(commit.mock.calls[0][0]).toMatchObject({ key: "Enter", cancelable: true, bubbles: true });
  expect(rename.mock.calls[0][0]).toMatchObject({ key: "Enter", type: "keyup" });
});

it("uses original task and group event surfaces without touching delete or Markdown controls", () => {
  const task = document.querySelector("article.task-card")!, group = document.querySelectorAll(".group-item")[1];
  const doubleClick = vi.fn(), context = vi.fn(), submit = vi.fn(event => event.preventDefault());
  const edit = vi.fn(), forbidden = vi.fn();
  task.addEventListener("dblclick", doubleClick); group.addEventListener("contextmenu", context);
  document.querySelector("form.inline-group-composer")!.addEventListener("submit", submit);
  document.querySelectorAll(".context-menu button")[1].addEventListener("click", edit);
  document.querySelector(".danger")!.addEventListener("click", forbidden);
  document.querySelectorAll('[aria-label="设置面板"] input')[1].addEventListener("click", forbidden);
  adapter.perform("edit-task", { text: ALPHA }); adapter.perform("toggle-task", { text: ALPHA });
  adapter.perform("edit-group", { title: "ATools synthetic group" }); adapter.perform("choose-group-edit");
  adapter.perform("set-group", { value: "ATools synthetic group" }); adapter.perform("commit-group");
  adapter.perform("toggle-hide-completed");
  expect(doubleClick).toHaveBeenCalledOnce(); expect(context.mock.calls[0][0]).toMatchObject({ type: "contextmenu", button: 2 });
  expect(submit).toHaveBeenCalledOnce(); expect(edit).toHaveBeenCalledOnce(); expect(forbidden).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLInputElement>("article.task-card input")!.checked).toBe(true);
  expect(adapter.state().hideCompleted).toBe(true);
});

it("moves search focus away from inputs and uses slash/Escape keyboard handlers", () => {
  const active = document.querySelector<HTMLInputElement>("input.group-edit")!; active.focus();
  const open = vi.fn(), close = vi.fn();
  document.body.addEventListener("keydown", open); document.querySelector("input.task-search-input")!.addEventListener("keydown", close);
  adapter.perform("open-search"); adapter.perform("set-search", { value: "alpha" }); adapter.perform("close-search");
  expect(document.activeElement).not.toBe(active);
  expect(open.mock.calls[0][0]).toMatchObject({ key: "/", target: document.body });
  expect(close.mock.calls[0][0]).toMatchObject({ key: "Escape", bubbles: true });
  expect(document.querySelector<HTMLInputElement>("input.task-search-input")!.value).toBe("alpha");
});

it.each([
  ["set-task", { value: "https://example.test/" }], ["set-task", { value: ALPHA + "\n" }],
  ["set-edit", { value: "arbitrary task" }], ["toggle-task", { text: "unreviewed" }],
  ["set-group", { value: "待处理" }], ["select-group", { title: "unknown" }],
  ["set-search", { value: "private data" }], ["delete-task", {}], ["invoke-tool", {}], ["open-note", {}],
])("rejects data or operations outside the fixed synthetic UI scope: %s", (operation, data) => {
  expect(() => adapter.perform(operation as string, data as Record<string, unknown>)).toThrow();
});
