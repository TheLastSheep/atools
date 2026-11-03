import { approvePublishedData, invoke, launcherInput, permissionDialog, verifyPublishedFrameIsolation } from "./nativePublishedPluginCommon";
import type { PublishedBusinessResult, PublishedFrameIsolation, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import { approvePublishedSaveDialog } from "./nativePublishedDialogPermission";

type TreeState = { ready: boolean; input: string; output: string; visibilityState: string; documentHidden: boolean };
const INPUT = "root\n=src\n==index.js", OUTPUT = "root\n└── src\n    └── index.js";
const REVERSE_INPUT = "root\n=docs\n==README.md", REVERSE_OUTPUT = "root\n└── docs\n    └── README.md";
async function snapshot(context: PublishedScenarioContext) {
  const database = await context.until(async () => {
    const value = await invoke<{ pluginId: string; readOnly: boolean; storage: { key: string; value: unknown } }>("native_published_data_snapshot");
    return value.pluginId === "ascii-tree" && value.readOnly === true && value.storage.key === "ascii-tree:level-text"
      && value.storage.value === INPUT ? value : null;
  }, "Independent SQLite projection did not retain the original ASCII Tree input");
  context.check(database.readOnly, "Independent read-only plugin-scoped SQLite projection contains the exact original ASCII Tree input");
  return database;
}
const waitState = (context: PublishedScenarioContext, input: string, output: string) => context.until(async () => {
  const value = await context.probe<TreeState>("state"); context.observations.originalAsciiTreeLastState = value;
  return value.ready && value.input === input && value.output === output ? value : null;
}, "Original ASCII Tree did not render the expected paired editor values");

export async function runOriginalAsciiTreeScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { probe, until, check, observations, setPhase } = context;
  await until(async () => (await probe<TreeState>("state")).ready, "Original ASCII Tree editors did not mount");
  setPhase("original-ascii-tree-level-text-input"); await probe("enter-level-text");
  const forward = await waitState(context, INPUT, OUTPUT);
  check(forward.output === OUTPUT, "Original ASCII Tree textarea input renders the fixed three-level tree");
  setPhase("original-ascii-tree-reverse-editor-input"); await probe("enter-tree-text");
  const reverse = await waitState(context, REVERSE_INPUT, REVERSE_OUTPUT);
  check(reverse.input === REVERSE_INPUT, "Original right editor input updates the left level-text editor");
  await probe("enter-level-text"); const persisted = await waitState(context, INPUT, OUTPUT);
  observations.originalAsciiTreeEditing = { forward, reverse, persisted, database: await snapshot(context) };
  return { tested: ["original left editor input and live tree rendering", "original right editor input and reverse synchronization"],
    notTested: ["physical keyboard/pointer", "foreground paint and visual comparison", "clipboard", "native save dialog and file export", "all indentation or malformed text cases", "large tree performance"],
    boundary: "Fixed programmatic DOM input events on the unchanged original textareas. Static save-dialog detection requires explicit startup permission, but this scenario never exports or opens a native panel. No render function, model, storage write or preload filesystem service is directly invoked. Whole-plugin persistence is verified separately after actual close and reopen." };
}

/** Call only after the shared scenario has closed the actual panel and drained all runtimes. */
export async function verifyOriginalAsciiTreeAfterReopen(context: PublishedScenarioContext, previousFrame: HTMLIFrameElement) {
  const { until, check, profile, probe, observations, setPhase } = context;
  setPhase("original-ascii-tree-whole-close-fresh-permission-reopen");
  check(!previousFrame.isConnected && !document.querySelector(".plugin-panel"), "Whole ASCII Tree close removes its original panel and iframe");
  const input = launcherInput(); check(input, "Launcher is available before original ASCII Tree reopen");
  input!.value = profile.searchQuery; input!.dispatchEvent(new Event("input", { bubbles: true }));
  const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === profile.featureCode), "Actual ASCII Tree catalog feature did not return after close");
  option.click(); observations.originalAsciiTreeReopenBeforeData = await approvePublishedData(context, "Reopened original ASCII Tree");
  observations.originalAsciiTreeReopenBeforeSave = await approvePublishedSaveDialog(context);
  await until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    const pending = await invoke<Array<{ tool_name: string; client_id: string }>>("list_pending_agent_requests");
    return title.includes(profile.title) && title.includes("请求访问本机") && pending.length === 1
      && /^legacy_node_[a-f0-9]{64}$/.test(pending[0].tool_name) && pending[0].client_id === "atools-ui";
  }, "Reopened original ASCII Tree did not request its exact fresh Node capability");
  const waiting = await invoke<RuntimeState>("native_published_runtime_state");
  check(waiting.legacySessions === 0 && waiting.pendingRequests === 1 && !document.querySelector('iframe[title="Plugin"]'),
    "Reopened original ASCII Tree waits for fresh Node permission before starting its page or Node session");
  const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "允许一次");
  check(allow, "Reopened original ASCII Tree offers explicit one-time Node approval"); allow!.click();
  const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Original ASCII Tree did not reopen a new iframe");
  check(frame !== previousFrame && frame.contentWindow !== previousFrame.contentWindow, "Original ASCII Tree reopens with a new iframe and browsing context");
  const restored = await waitState(context, INPUT, OUTPUT);
  const isolation = verifyPublishedFrameIsolation(frame, await probe<PublishedFrameIsolation>("state"), check);
  const runtime = await invoke<RuntimeState>("native_published_runtime_state");
  check(runtime.dataSessions === 1 && runtime.dataTransport && runtime.legacySessions === 1 && runtime.legacyTransport
    && runtime.hostSessions === 0 && !runtime.hostTransport && runtime.activePathSnapshots === 0 && runtime.pendingRequests === 0
    && runtime.dialogSessions === 1 && runtime.dialogTransport && runtime.nativeDialogs === 0
    && runtime.dialogIntents === 0 && runtime.dialogPreparations === 0 && runtime.dialogInvocations === 0,
    "Reopened original ASCII Tree owns fresh data, Node and unused save permission sessions without clipboard, paths or a native panel");
  observations.originalAsciiTreeAfterWholeReopen = { restored, isolation, runtime, database: await snapshot(context),
    freshOneTimeApprovals: 3, newIframe: true, documentsInjected: false, nativePanelOpened: false,
    savePermissionBoundary: "Static source detection requires fresh startup save permission; no export control, filesystem service or native panel is invoked by this scenario." };
}
