import { approvePublishedData, invoke, launcherInput, publishedWebRuntimeReady, verifyPublishedFrameIsolation } from "./nativePublishedPluginCommon";
import type { PublishedBusinessResult, PublishedFrameIsolation, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";

const ALPHA = "ATools Todo synthetic alpha", BETA = "ATools Todo synthetic beta";
const EDITED = "ATools Todo synthetic alpha edited", GROUP = "ATools synthetic group", RENAMED = "ATools renamed group";
type TodoState = {
  mainPage: boolean; activeGroup: string; groups: { title: string; active: boolean; pendingCount: string }[];
  tasks: { text: string; completed: boolean; done: boolean; active: boolean }[];
  creating: boolean; createText: string; editing: boolean; editText: string;
  creatingGroup: boolean; groupText: string; editingGroup: boolean; groupEditText: string;
  settingsOpen: boolean; hideCompleted: boolean; searchOpen: boolean; searchQuery: string;
  searchResults: { text: string; group: string }[]; searchEmpty: string; disabledWindowControls: number;
};
type TodoSnapshot = {
  pluginId: string; source: string; readOnly: boolean;
  tasks: { id: string; text: string; groupId: string; completed: boolean; createdAt?: number;
    completedAt?: number; firstCompletedAt?: number; rev?: string }[];
  groups: { id: string; title: string; sort?: number }[];
  settings: { hideCompleted?: boolean; bottomCompleted?: boolean; renderMarkdown?: boolean } | null;
  activeGroupId?: string; activeTaskId?: string;
};
function assertTodoCase(context: PublishedScenarioContext) {
  const profile = context.profile;
  const original = profile.caseId === "todo-neo";
  const converted = profile.caseId === "converted-todo-neo-source" && profile.sourceKind === "converted_handoff_directory";
  if ((!original && !converted) || profile.id !== "todo-neo" || profile.runtime !== "web" || profile.dataAccess !== true
    || profile.pathAccess !== "none") throw Error("Todo business scenario is not bound to an approved Todo profile");
}
const waitState = (context: PublishedScenarioContext, accept: (value: TodoState) => boolean, label: string) => context.until(async () => {
  const value = await context.probe<TodoState>("state"); return accept(value) ? value : null;
}, label);
async function snapshot(context: PublishedScenarioContext, accept: (value: TodoSnapshot) => boolean, label: string) {
  const value = await context.until(async () => {
    const current = await invoke<TodoSnapshot>("native_published_data_snapshot"); return accept(current) ? current : null;
  }, label);
  context.check(value.pluginId === "todo-neo" && value.readOnly === true && typeof value.source === "string" && value.source.length > 0,
    "Todo evidence is an independent read-only projection of plugin-scoped SQLite");
  return value;
}
async function createTask(context: PublishedScenarioContext, text: string, count: number) {
  await context.probe("new-task");
  await waitState(context, state => state.creating, "Original Todo task composer did not open");
  await context.probe("set-task", { value: text });
  await waitState(context, state => state.createText === text, "Todo composer did not receive the actual input event");
  await context.probe("commit-task");
  return waitState(context, state => !state.creating && state.tasks.length === count && state.tasks.some(task => task.text === text),
    "Original Todo did not save the task through its Enter handler");
}
async function openSettings(context: PublishedScenarioContext) {
  await context.probe("open-settings");
  return waitState(context, state => state.settingsOpen, "Original Todo settings drawer did not open");
}
async function closeSettings(context: PublishedScenarioContext) {
  await context.probe("close-settings");
  await waitState(context, state => !state.settingsOpen, "Original Todo settings drawer did not close");
}

export async function runPublishedBusinessScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  assertTodoCase(context);
  const { check, probe, observations, setPhase } = context;
  setPhase("todo-default-groups-and-sqlite");
  let state = await waitState(context, value => value.mainPage && value.groups.length === 3, "Original Todo did not render its default groups");
  check(state.groups.map(group => group.title).join("|") === "待处理|进行中|未命名" && state.tasks.length === 0
    && state.activeGroup === "待处理", "Empty isolated Todo database renders the original three default groups and empty pending list");
  check(state.disabledWindowControls === 0, "Original Todo keeps its disabled note and tomato window controls absent");
  observations.todoInitialDatabase = await snapshot(context, value => value.groups.length === 3 && value.tasks.length === 0,
    "Original default groups did not reach the actual SQLite document store");

  setPhase("todo-original-create-edit-complete");
  await createTask(context, ALPHA, 1); state = await createTask(context, BETA, 2);
  check(state.tasks.every(task => !task.completed), "Original Todo creates exactly two pending synthetic tasks");
  await probe("edit-task", { text: ALPHA });
  await waitState(context, value => value.editing && value.editText === ALPHA, "Double-click did not open the original task editor");
  await probe("set-edit", { value: EDITED });
  await waitState(context, value => value.editText === EDITED, "Original editor did not receive replacement input");
  await probe("commit-edit");
  await waitState(context, value => !value.editing && value.tasks.some(task => task.text === EDITED), "Original Enter handler did not save task edits");
  await probe("toggle-task", { text: EDITED });
  state = await waitState(context, value => value.tasks.some(task => task.text === EDITED && task.completed && task.done), "Original checkbox did not complete the edited task");
  const completed = await snapshot(context, value => value.tasks.some(task => task.text === EDITED && task.completed
    && Number(task.completedAt) > 0 && Number(task.firstCompletedAt) > 0), "Completed Todo task and timestamps did not persist in SQLite");
  await probe("toggle-task", { text: EDITED });
  await waitState(context, value => value.tasks.some(task => task.text === EDITED && !task.completed && !task.done), "Original checkbox did not restore the pending task");
  const pending = await snapshot(context, value => value.tasks.some(task => task.text === EDITED && !task.completed && !task.completedAt),
    "Restoring Todo pending status did not clear the actual completion timestamp");
  check(pending.tasks.find(task => task.text === EDITED)?.firstCompletedAt === completed.tasks.find(task => task.text === EDITED)?.firstCompletedAt,
    "Original completion recovery retains the first completion timestamp in SQLite");
  observations.todoCompletion = { completed, pending };

  setPhase("todo-original-search-and-completion-filter");
  await probe("open-search");
  await waitState(context, value => value.searchOpen, "Original slash shortcut did not open Todo search");
  await probe("set-search", { value: "alpha" });
  state = await waitState(context, value => value.searchQuery === "alpha" && value.searchResults.length === 1
    && value.searchResults[0].text === EDITED, "Original Todo search did not find only the matching edited task");
  check(state.searchResults[0].group === "待处理", "Original text search retains its matching task's actual group");
  await probe("set-search", { value: "ATools Todo synthetic absent" });
  state = await waitState(context, value => value.searchResults.length === 0 && value.searchEmpty === "无匹配", "Original Todo search did not render its no-match state");
  await probe("close-search");
  await waitState(context, value => !value.searchOpen, "Original Escape handler did not close search");
  await probe("toggle-task", { text: EDITED });
  await waitState(context, value => value.tasks.some(task => task.text === EDITED && task.completed), "Todo completion did not update before filtering");
  state = await openSettings(context); check(!state.hideCompleted, "Original Todo starts with completed tasks visible");
  await probe("toggle-hide-completed");
  await waitState(context, value => value.hideCompleted, "Original settings checkbox did not enable hiding completed tasks");
  await closeSettings(context);
  state = await waitState(context, value => value.tasks.length === 1 && value.tasks[0].text === BETA, "Original completed-task filter did not hide only the completed task");
  state = await openSettings(context);
  check(state.hideCompleted, "Original settings drawer close and reopen retains the selected completion filter");
  await probe("toggle-hide-completed");
  await waitState(context, value => !value.hideCompleted, "Original completion filter did not turn off");
  await closeSettings(context);
  await waitState(context, value => value.tasks.length === 2, "Turning off the original filter did not reveal the completed task");
  await probe("toggle-task", { text: EDITED });
  await waitState(context, value => value.tasks.length === 2 && value.tasks.every(task => !task.completed), "Todo did not restore both tasks to pending");
  await openSettings(context); await probe("toggle-hide-completed");
  await waitState(context, value => value.hideCompleted, "Todo did not retain the chosen final persisted setting");
  await closeSettings(context);

  setPhase("todo-original-group-create-rename-and-return");
  await probe("new-group");
  await waitState(context, value => value.creatingGroup, "Original group composer did not open");
  await probe("set-group", { value: GROUP });
  await waitState(context, value => value.groupText === GROUP, "Original group composer did not receive input");
  await probe("commit-group");
  await waitState(context, value => !value.creatingGroup && value.groups.length === 4 && value.activeGroup === GROUP && value.tasks.length === 0,
    "Original group submit did not create and select the empty synthetic group");
  await probe("edit-group", { title: GROUP }); await probe("choose-group-edit");
  await waitState(context, value => value.editingGroup && value.groupEditText === GROUP, "Original group context menu did not open its rename input");
  await probe("set-group-edit", { value: RENAMED });
  await waitState(context, value => value.groupEditText === RENAMED, "Original group rename input did not update");
  await probe("commit-group-edit");
  await waitState(context, value => !value.editingGroup && value.activeGroup === RENAMED, "Original Enter keyup did not persist the renamed group");
  await probe("select-group", { title: "待处理" });
  state = await waitState(context, value => value.activeGroup === "待处理" && value.tasks.length === 2 && value.tasks.every(task => !task.completed),
    "Leaving and returning to the original pending group did not restore its tasks");
  check(state.tasks.some(task => task.text === EDITED) && state.tasks.some(task => task.text === BETA), "Original group navigation retains both exact synthetic task contents");
  await probe("select-group", { title: RENAMED });
  await waitState(context, value => value.activeGroup === RENAMED && value.tasks.length === 0, "Renamed original group did not retain its empty list");
  observations.todoBeforeWholeClose = await snapshot(context, value => value.tasks.length === 2 && value.groups.length === 4
    && value.settings?.hideCompleted === true && value.groups.some(group => group.title === RENAMED && group.id === value.activeGroupId),
    "Original task, group, active selection and filter values did not persist in actual SQLite");
  return { businessOutcome: "scoped_pass", tested: ["three original default groups", "two task creations, edit and completion recovery",
    "text search match and no-match", "completed-task visibility and settings drawer reopen", "group creation, rename and navigation persistence"],
    notTested: ["full page remount before whole-plugin close", "MCP/tool calls", "add feature and notifications", "clipboard", "AI", "note/tomato windows",
      "Markdown/links", "deletion", "dragging", "due-date filters", "physical keyboard/pointer", "large task-list performance", "other plugins"],
    boundary: "Original DOM input/change/click/double-click/context-menu/keyboard/submit handlers only; no services, database writes or reactive state injection. Drawer/group navigation is not a page remount." };
}

export async function verifyTodoAfterReopen(context: PublishedScenarioContext, previousFrame: HTMLIFrameElement) {
  assertTodoCase(context);
  const { until, check, profile, probe, observations, setPhase } = context;
  setPhase("todo-whole-plugin-close-and-fresh-data-reopen");
  check(!previousFrame.isConnected, "Whole Todo close removes the previous original iframe");
  const input = launcherInput(); check(input, "Launcher is present before whole Todo reopen");
  input!.value = profile.searchQuery; input!.dispatchEvent(new Event("input", { bubbles: true }));
  const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === profile.featureCode), "Actual Todo catalog row did not return after close");
  option.click();
  observations.todoReopenBeforePermission = await approvePublishedData(context, "Reopened original Todo");
  const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Original Todo did not reopen its iframe");
  check(frame !== previousFrame && frame.contentWindow !== previousFrame.contentWindow,
    "Whole Todo reopen creates a new iframe and browsing context after fresh one-time data approval");
  let state = await waitState(context, value => value.mainPage && value.groups.length === 4 && value.activeGroup === RENAMED,
    "Original Todo did not restore the renamed active group in its new iframe");
  check(state.tasks.length === 0, "New original Todo iframe restores the renamed group's empty task list");
  observations.todoReopenedFrameIsolation = verifyPublishedFrameIsolation(frame, await probe<PublishedFrameIsolation>("state"), check);
  state = await openSettings(context); check(state.hideCompleted, "Fresh original Todo iframe reloads its saved completion filter from SQLite");
  await closeSettings(context); await probe("select-group", { title: "待处理" });
  state = await waitState(context, value => value.activeGroup === "待处理" && value.tasks.length === 2
    && value.tasks.every(task => !task.completed) && value.tasks.some(task => task.text === EDITED) && value.tasks.some(task => task.text === BETA),
    "Original edited task and pending statuses disappeared after whole-plugin reopen");
  const database = await snapshot(context, value => value.tasks.length === 2 && value.tasks.some(task => task.text === EDITED && !task.completed)
    && value.tasks.some(task => task.text === BETA && !task.completed) && value.groups.some(group => group.title === RENAMED)
    && value.settings?.hideCompleted === true, "Persisted Todo documents did not survive whole-plugin close and new iframe");
  const runtime = await invoke<RuntimeState>("native_published_runtime_state");
  check(publishedWebRuntimeReady(runtime, true), "Reopened original Todo owns one approved data session and no Node or clipboard runtime");
  observations.todoAfterWholeReopen = { state, database, runtime, freshOneTimeApprovals: 1, newIframe: true, documentsInjected: false };
}
