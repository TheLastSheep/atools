import "../../src/styles/global.css";
import "../../src/styles/settings-responsive.css";
import SystemPanel from "../../src/components/SystemPanel.svelte";
import {
  dispatchDomClick,
  dispatchNativeInput,
  sampleLaunchControl,
  waitForKnownLaunchState,
} from "./fallbackSettingsNativeReadiness";
import { mount, tick, unmount } from "svelte";

type SaveState = "saved" | "saving" | "error" | "unknown";
type Observation = {
  ready: boolean | null;
  controlUnique: boolean | null;
  enabled: boolean | null;
  disabled: boolean | null;
  indeterminate: boolean | null;
  overviewUnknown: boolean | null;
  hasConflictMessage: boolean | null;
  saveState: SaveState;
};
type ProbeResult = {
  ok: boolean;
  reason: string | null;
  dispatched: boolean | null;
  before: Observation;
  after: Observation;
};
type Probe = {
  inspect(): Promise<Observation>;
  disable(): Promise<ProbeResult>;
  editPlaceholder(): Promise<ProbeResult & { placeholderObserved: boolean | null }>;
  conflict(): Promise<ProbeResult>;
  reread(): Promise<ProbeResult>;
};

declare global {
  interface Window {
    __ATOOLS_FALLBACK_SETTINGS_NATIVE__?: Readonly<Probe>;
  }
}

const DEADLINE_MS = 6_000;
const POLL_MS = 25;
const PLACEHOLDER_VALUE = "ATools R51 login cross entry";
const CONFLICT_MESSAGE = "系统启动项状态已变化，请重新读取后再试。";
const UNKNOWN_OBSERVATION: Observation = Object.freeze({
  ready: null,
  controlUnique: null,
  enabled: null,
  disabled: null,
  indeterminate: null,
  overviewUnknown: null,
  hasConflictMessage: null,
  saveState: "unknown",
});
const mounted = mount(SystemPanel, {
  target: document.getElementById("fallback-settings-app")!,
  props: { panel: "settings", settingsMenu: "general", onpanelchange: () => undefined },
});

function settingPanel(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("section.settings-panel"));
}

function launchControls(panel: ParentNode): HTMLInputElement[] {
  return Array.from(panel.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"][aria-label="开机自动启动"]',
  ));
}

function currentSaveState(panel: ParentNode): SaveState {
  const nodes = panel.querySelectorAll<HTMLElement>(".settings-sidebar .save-status");
  if (nodes.length !== 1) return "unknown";
  const label = nodes[0].textContent?.trim();
  if (label === "已保存") return "saved";
  if (label === "保存中") return "saving";
  if (label === "保存失败") return "error";
  return "unknown";
}

function overviewUnknown(panel: ParentNode): boolean | null {
  const cards = Array.from(panel.querySelectorAll<HTMLElement>(".general-overview-card"))
    .filter(card => card.querySelector("span")?.textContent?.trim() === "系统入口");
  if (cards.length !== 1) return null;
  const value = cards[0].querySelector("strong")?.textContent?.trim();
  if (!value) return null;
  if (value.includes("启动状态未知")) return true;
  if (value.includes("开机启动") || value.includes("手动启动")) return false;
  return null;
}

function readObservation(): Observation {
  const panels = settingPanel();
  const panel = panels.length === 1 ? panels[0] : null;
  const launchControl = sampleLaunchControl(document);
  const statuses = panel?.querySelectorAll<HTMLElement>(".launch-at-login-status") ?? [];
  return {
    ...launchControl,
    overviewUnknown: panel ? overviewUnknown(panel) : null,
    hasConflictMessage: !panel ? null
      : statuses.length === 0 ? false
        : statuses.length === 1 ? (statuses[0].textContent ?? "").includes(CONFLICT_MESSAGE)
          : null,
    saveState: panel ? currentSaveState(panel) : "unknown",
  };
}

function safeObservation(): Observation {
  try {
    return readObservation();
  } catch {
    return UNKNOWN_OBSERVATION;
  }
}

function waitTick(deadline: number): Promise<void> {
  const remaining = Math.max(0, deadline - performance.now());
  return new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, remaining)));
}

async function waitForObservation(
  deadline: number,
  accept: (value: Observation) => boolean,
): Promise<Observation> {
  let observed = safeObservation();
  while (performance.now() < deadline && !accept(observed)) {
    await waitTick(deadline);
    observed = safeObservation();
  }
  return observed;
}

function result(
  ok: boolean,
  reason: string | null,
  dispatched: boolean | null,
  before: Observation,
  after: Observation,
): ProbeResult {
  return { ok, reason, dispatched, before, after };
}

async function inspect(): Promise<Observation> {
  const deadline = performance.now() + DEADLINE_MS;
  return waitForKnownLaunchState(() => safeObservation(), deadline);
}

async function disable(): Promise<ProbeResult> {
  const deadline = performance.now() + DEADLINE_MS;
  let before = UNKNOWN_OBSERVATION;
  let dispatched: boolean | null = false;
  try {
    before = await waitForKnownLaunchState(() => safeObservation(), deadline);
    if (before.ready !== true || before.controlUnique !== true) {
      return result(false, "control-unavailable", false, before, safeObservation());
    }
    if (before.enabled !== true || before.disabled !== false || before.indeterminate !== false) {
      return result(false, "control-not-enabled", false, before, safeObservation());
    }
    const panels = settingPanel();
    const controls = panels.length === 1 ? launchControls(panels[0]) : [];
    if (controls.length !== 1) return result(false, "control-unavailable", false, before, safeObservation());
    dispatched = dispatchDomClick(controls[0]);
    if (dispatched !== true) return result(false, "click-not-dispatched", dispatched, before, safeObservation());
    const after = await waitForObservation(deadline, value =>
      (value.enabled === false && value.disabled === false && value.indeterminate === false)
        || value.hasConflictMessage === true,
    );
    const ok = after.enabled === false && after.disabled === false && after.indeterminate === false;
    return result(ok, ok ? null : after.hasConflictMessage === true ? "native-conflict" : "action-not-confirmed", dispatched, before, after);
  } catch {
    return result(false, "probe-failed", dispatched, before, safeObservation());
  }
}

async function conflict(): Promise<ProbeResult> {
  const deadline = performance.now() + DEADLINE_MS;
  let before = UNKNOWN_OBSERVATION;
  let dispatched: boolean | null = false;
  try {
    before = await waitForKnownLaunchState(() => safeObservation(), deadline);
    if (before.ready !== true || before.controlUnique !== true) {
      return result(false, "control-unavailable", false, before, safeObservation());
    }
    if (before.enabled !== true || before.disabled !== false || before.indeterminate !== false) {
      return result(false, "control-not-enabled", false, before, safeObservation());
    }
    const panels = settingPanel();
    const controls = panels.length === 1 ? launchControls(panels[0]) : [];
    if (controls.length !== 1) return result(false, "control-unavailable", false, before, safeObservation());
    dispatched = dispatchDomClick(controls[0]);
    if (dispatched !== true) return result(false, "click-not-dispatched", dispatched, before, safeObservation());
    const after = await waitForObservation(deadline, value =>
      value.enabled === null && value.disabled === true && value.indeterminate === true && value.hasConflictMessage === true,
    );
    const ok = after.enabled === null && after.disabled === true && after.indeterminate === true && after.hasConflictMessage === true;
    return result(ok, ok ? null : "conflict-not-observed", dispatched, before, after);
  } catch {
    return result(false, "probe-failed", dispatched, before, safeObservation());
  }
}

async function reread(): Promise<ProbeResult> {
  const deadline = performance.now() + DEADLINE_MS;
  let before = UNKNOWN_OBSERVATION;
  let dispatched: boolean | null = false;
  try {
    before = await waitForObservation(deadline, value => value.ready === true && value.controlUnique === true);
    if (before.ready !== true || before.controlUnique !== true) {
      return result(false, "control-unavailable", false, before, safeObservation());
    }
    const panels = settingPanel();
    if (panels.length !== 1) return result(false, "control-unavailable", false, before, safeObservation());
    const panel = panels[0];
    const retryButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>(
      ".launch-at-login-retry",
    )).filter(button => button.textContent?.trim() === "重新读取");
    if (retryButtons.length !== 1 || retryButtons[0].disabled) {
      return result(false, "reread-control-unavailable", false, before, safeObservation());
    }
    dispatched = dispatchDomClick(retryButtons[0]);
    if (dispatched !== true) return result(false, "click-not-dispatched", dispatched, before, safeObservation());
    const after = await waitForObservation(deadline, value =>
      value.enabled !== null && value.disabled === false && value.indeterminate === false && value.hasConflictMessage === false,
    );
    const ok = after.enabled !== null && after.disabled === false
      && after.indeterminate === false && after.hasConflictMessage === false;
    return result(ok, ok ? null : "reread-not-confirmed", dispatched, before, after);
  } catch {
    return result(false, "probe-failed", dispatched, before, safeObservation());
  }
}

async function editPlaceholder(): Promise<ProbeResult & { placeholderObserved: boolean | null }> {
  const deadline = performance.now() + DEADLINE_MS;
  let before = UNKNOWN_OBSERVATION;
  let dispatched: boolean | null = false;
  let placeholderObserved: boolean | null = null;
  try {
    before = await waitForKnownLaunchState(() => safeObservation(), deadline);
    if (before.ready !== true || before.controlUnique !== true) {
      return { ...result(false, "control-unavailable", false, before, safeObservation()), placeholderObserved: null };
    }
    const panels = settingPanel();
    if (panels.length !== 1) {
      return { ...result(false, "control-unavailable", false, before, safeObservation()), placeholderObserved: null };
    }
    const panel = panels[0];
    const inputs = Array.from(panel.querySelectorAll<HTMLInputElement>(
      'input[aria-label="搜索框提示文字"]',
    ));
    if (inputs.length !== 1 || inputs[0].disabled) {
      return { ...result(false, "placeholder-control-unavailable", false, before, safeObservation()), placeholderObserved: null };
    }

    const saveStatus = panel.querySelector<HTMLElement>(".settings-sidebar .save-status");
    if (!saveStatus) {
      return { ...result(false, "save-status-unavailable", false, before, safeObservation()), placeholderObserved: null };
    }
    let sawSaving = currentSaveState(panel) === "saving";
    const observer = new MutationObserver(() => {
      if (currentSaveState(panel) === "saving") sawSaving = true;
    });
    observer.observe(saveStatus, { childList: true, characterData: true, subtree: true });
    try {
      const inputDispatch = dispatchNativeInput(inputs[0], PLACEHOLDER_VALUE);
      dispatched = inputDispatch.dispatched;
      placeholderObserved = inputDispatch.valueObserved;
      if (dispatched === false) {
        return {
          ...result(false, "native-input-not-dispatched", dispatched, before, safeObservation()),
          placeholderObserved,
        };
      }
      if (currentSaveState(panel) === "saving") sawSaving = true;

      const after = await waitForObservation(deadline, value =>
        sawSaving && value.saveState === "saved" && inputs[0].value === PLACEHOLDER_VALUE,
      );
      placeholderObserved = inputs[0].value === PLACEHOLDER_VALUE;
      const ok = dispatched === true && sawSaving && after.saveState === "saved" && placeholderObserved === true;
      return {
        ...result(ok, ok ? null : "placeholder-save-not-confirmed", dispatched, before, after),
        placeholderObserved,
      };
    } finally {
      observer.disconnect();
    }
  } catch {
    return {
      ...result(false, "probe-failed", dispatched, before, safeObservation()),
      placeholderObserved,
    };
  }
}

async function dispose(): Promise<void> {
  await unmount(mounted);
  await tick();
}

const probe: Probe = Object.freeze({
  async inspect() {
    try { return await inspect(); } catch { return UNKNOWN_OBSERVATION; }
  },
  async disable() {
    try { return await disable(); } catch { return result(false, "probe-failed", null, UNKNOWN_OBSERVATION, safeObservation()); }
  },
  async editPlaceholder() {
    try { return await editPlaceholder(); } catch {
      return { ...result(false, "probe-failed", null, UNKNOWN_OBSERVATION, safeObservation()), placeholderObserved: null };
    }
  },
  async conflict() {
    try { return await conflict(); } catch { return result(false, "probe-failed", null, UNKNOWN_OBSERVATION, safeObservation()); }
  },
  async reread() {
    try { return await reread(); } catch { return result(false, "probe-failed", null, UNKNOWN_OBSERVATION, safeObservation()); }
  },
});
Object.defineProperty(window, "__ATOOLS_FALLBACK_SETTINGS_NATIVE__", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: probe,
});
window.addEventListener("pagehide", () => { void dispose(); }, { once: true });
