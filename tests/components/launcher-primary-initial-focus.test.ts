import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";
import LauncherPrimarySurface from "../../src/components/LauncherPrimarySurface.svelte";
import { homeCommandStatus } from "../../src/lib/homeSurface";
import { DEFAULT_ATOOLS_SETTINGS } from "../../src/lib/settings";
import type { LauncherResultsSurfaceProps } from "../../src/components/LauncherResultsSurface.svelte";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function emptyResultsSurface(): LauncherResultsSurfaceProps {
  const recentCommands: LauncherResultsSurfaceProps["recentCommands"] = [];
  return {
    results: [], selectedIndex: 0, query: "",
    feedback: { mode: "none", title: "", hint: "", showSpinner: false },
    onselect: () => {}, onselectionchange: () => {}, oncommandmenu: () => {},
    canOpenCommandMenu: () => false, ongroupenter: () => {},
    showQueryResults: false, showHomeRecent: false, showTabTargetStatus: false,
    recentCommands, recentSelectedIndex: 0, recentSelectedLabel: "",
    recentStatus: homeCommandStatus(recentCommands, 0, { pinnedRows: 1, recentRows: 2 }),
    settings: { ...DEFAULT_ATOOLS_SETTINGS }, tabAction: "", tabTargetFeedback: "",
    featureCatalog: [], pushState: { rows: [], pending: false, deferred: 0, message: "", promotedId: null },
    onHomeCommand: () => {}, onHomePanelChange: () => {}, onRecentSelectionChange: () => {},
    onRecentActivate: () => {}, onRecentRemove: () => {}, onRecentCommandMenu: () => {},
    onTargetSettings: () => {}, onBindResultsList: () => {},
  };
}

it("production launcher surface explicitly focuses its initial search input", async () => {
  const invoke = async <T = unknown>(): Promise<T> => { throw new Error("unused invoke"); };
  const listen = async <T>(_event: string, _receive: (event: { payload: T }) => void) => () => {};
  render(LauncherPrimarySurface, {
    props: {
      activePanel: "home", expanded: false, contentVisible: false, searchVisible: true,
      targetHeight: 541, activationError: "", showSettingsHeader: false, query: "",
      placeholder: "Search", focusToken: 0, selectAllToken: 0, matchSummary: null, mediaContext: null,
      resultsExpanded: false, onQueryChange: () => {}, onMediaRemove: () => {}, onMatchEdit: () => {},
      onMatchRemove: () => {}, onBadgeClick: () => {}, onPaste: () => {}, onPanelChange: () => {},
      lifecycleNotice: null, detached: false, onReturn: () => {}, activePlugin: null, pluginPanelProps: null,
      hidePluginPanel: false, onPluginPanelInstance: () => {}, resultsSurface: emptyResultsSurface(),
      settingsMenu: "general", marketRequest: null, onMarketRequest: () => {}, onMainPushInstance: () => {},
      mainPushQuery: "", mainPushFixed: false, mainPushFilter: "", mainPushActive: false, invoke, listen,
      onMainPushClose: () => {}, onEscape: () => {}, onRedirect: () => false, onSettingsRedirect: () => false,
      onMainPushUpdate: () => {}, onMainPushActivate: async () => {},
    },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await waitFor(() => expect(document.activeElement).toBe(input));
});
