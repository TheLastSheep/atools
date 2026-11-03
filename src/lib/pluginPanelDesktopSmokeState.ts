import { normalizeDesktopBrowserWindowProbeContract } from "./desktopBrowserWindowIsolationProbe";

export type DesktopSmokeBridgeProbeResult = {
  reported: boolean;
  passed: boolean;
  checks: number;
  passedChecks: number;
  failedIds: string[];
  domInputVisible: boolean;
  domInputPlaceholder: string;
  nativeMethodReported: boolean;
  nativeMethodPassed: boolean;
  nativeMethodChecks: number;
  nativeMethodPassedChecks: number;
  nativeMethodFailedIds: string[];
  browserWindowProbeExpected: boolean;
  browserWindowProbeReported: boolean;
  browserWindowProbePassed: boolean;
  browserWindowProbeChecks: number;
  browserWindowProbePassedChecks: number;
  browserWindowProbeFailedIds: string[];
  browserWindowCreated: boolean;
  browserWindowChildOriginOpaque: boolean;
  browserWindowSelfTauriUnavailable: boolean;
  browserWindowParentTauriUnavailable: boolean;
  browserWindowParentDocumentBlocked: boolean;
  browserWindowSendToParentChecked: boolean;
  browserWindowExecuteJavascriptChecked: boolean;
  browserWindowIpcRoundtripChecked: boolean;
  browserWindowCleanupChecked: boolean;
};

type DesktopSmokeBridgeProbeWaiter = {
  pluginId: string;
  featureCode: string;
  sampleIndex: number;
  resolve: (result: DesktopSmokeBridgeProbeResult) => void;
  timeoutId: number;
};


export function createDesktopSmokeBridgeProbeState(dependencies: { isEnabled: () => boolean; getSampleIndex: () => number }) {
  const { isEnabled, getSampleIndex } = dependencies;
  let desktopSmokeBridgeProbeWaiter: DesktopSmokeBridgeProbeWaiter | null = null;
function desktopSmokeBridgeProbeFailure(reason: string): DesktopSmokeBridgeProbeResult {
  const browserWindowProbeExpected = getSampleIndex() === 0;
  return {
    reported: false,
    passed: false,
    checks: 0,
    passedChecks: 0,
    failedIds: [reason],
    domInputVisible: false,
    domInputPlaceholder: "",
    nativeMethodReported: false,
    nativeMethodPassed: false,
    nativeMethodChecks: 0,
    nativeMethodPassedChecks: 0,
    nativeMethodFailedIds: [reason],
    browserWindowProbeExpected,
    browserWindowProbeReported: false,
    browserWindowProbePassed: false,
    browserWindowProbeChecks: 0,
    browserWindowProbePassedChecks: 0,
    browserWindowProbeFailedIds: browserWindowProbeExpected ? [reason] : [],
    browserWindowCreated: false,
    browserWindowChildOriginOpaque: false,
    browserWindowSelfTauriUnavailable: false,
    browserWindowParentTauriUnavailable: false,
    browserWindowParentDocumentBlocked: false,
    browserWindowSendToParentChecked: false,
    browserWindowExecuteJavascriptChecked: false,
    browserWindowIpcRoundtripChecked: false,
    browserWindowCleanupChecked: false,
  };
}

function desktopSmokeBridgeProbeTimeoutMs(iframeSrcdocBytes: number) {
  const bytes = Number.isFinite(iframeSrcdocBytes) ? Math.max(0, iframeSrcdocBytes) : 0;
  const sizeBudget = Math.ceil(bytes / 512_000) * 1000;
  return Math.min(20000, Math.max(12000, 4500 + sizeBudget));
}

function normalizeDesktopSmokeProbeList(value: unknown) {
  const probes = Array.isArray(value) ? value : [];
  const normalized = probes
    .map((probe) => {
      if (!probe || typeof probe !== "object") return null;
      const record = probe as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "unknown";
      return { id, passed: record.passed === true };
    })
    .filter((probe): probe is { id: string; passed: boolean } => probe !== null);
  const failedIds = normalized.filter((probe) => !probe.passed).map((probe) => probe.id);
  return {
    reported: Array.isArray(value),
    passed: normalized.length > 0 && failedIds.length === 0,
    checks: normalized.length,
    passedChecks: normalized.length - failedIds.length,
    failedIds,
  };
}

function normalizeDesktopSmokeBridgeProbe(data: Record<string, unknown>): DesktopSmokeBridgeProbeResult {
  const bridgeProbe = normalizeDesktopSmokeProbeList(data.probes);
  const nativeMethodProbe = normalizeDesktopSmokeProbeList(data.nativeMethodProbes);
  const browserWindowProbeExpected = Number(data.sampleIndex) === 0;
  const browserWindowProbe = browserWindowProbeExpected
    ? normalizeDesktopBrowserWindowProbeContract(data.browserWindowProbes)
    : normalizeDesktopSmokeProbeList(null);
  const browserWindowProbeReported = browserWindowProbeExpected
    && data.browserWindowProbeExpected === true
    && data.browserWindowProbeReported === true
    && browserWindowProbe.reported;
  const browserWindowProbePassed = browserWindowProbeReported
    && data.browserWindowProbePassed === true
    && browserWindowProbe.passed
    && browserWindowProbe.checks === 9
    && browserWindowProbe.passedChecks === 9;
  return {
    reported: bridgeProbe.reported,
    passed: bridgeProbe.passed,
    checks: bridgeProbe.checks,
    passedChecks: bridgeProbe.passedChecks,
    failedIds: bridgeProbe.failedIds,
    domInputVisible: data.domInputVisible === true,
    domInputPlaceholder: typeof data.domInputPlaceholder === "string" ? data.domInputPlaceholder : "",
    nativeMethodReported: nativeMethodProbe.reported,
    nativeMethodPassed: nativeMethodProbe.passed,
    nativeMethodChecks: nativeMethodProbe.checks,
    nativeMethodPassedChecks: nativeMethodProbe.passedChecks,
    nativeMethodFailedIds: nativeMethodProbe.failedIds,
    browserWindowProbeExpected,
    browserWindowProbeReported,
    browserWindowProbePassed,
    browserWindowProbeChecks: browserWindowProbeExpected ? browserWindowProbe.checks : 0,
    browserWindowProbePassedChecks: browserWindowProbeExpected ? browserWindowProbe.passedChecks : 0,
    browserWindowProbeFailedIds: browserWindowProbeExpected ? browserWindowProbe.failedIds : [],
    browserWindowCreated: browserWindowProbeExpected && data.browserWindowCreated === true,
    browserWindowChildOriginOpaque: browserWindowProbeExpected && data.browserWindowChildOriginOpaque === true,
    browserWindowSelfTauriUnavailable: browserWindowProbeExpected && data.browserWindowSelfTauriUnavailable === true,
    browserWindowParentTauriUnavailable: browserWindowProbeExpected && data.browserWindowParentTauriUnavailable === true,
    browserWindowParentDocumentBlocked: browserWindowProbeExpected && data.browserWindowParentDocumentBlocked === true,
    browserWindowSendToParentChecked: browserWindowProbeExpected && data.browserWindowSendToParentChecked === true,
    browserWindowExecuteJavascriptChecked: browserWindowProbeExpected && data.browserWindowExecuteJavascriptChecked === true,
    browserWindowIpcRoundtripChecked: browserWindowProbeExpected && data.browserWindowIpcRoundtripChecked === true,
    browserWindowCleanupChecked: browserWindowProbeExpected && data.browserWindowCleanupChecked === true,
  };
}

function resolveDesktopSmokeBridgeProbe(result: DesktopSmokeBridgeProbeResult) {
  if (!desktopSmokeBridgeProbeWaiter) return;
  const waiter = desktopSmokeBridgeProbeWaiter;
  desktopSmokeBridgeProbeWaiter = null;
  window.clearTimeout(waiter.timeoutId);
  waiter.resolve(result);
}


function waitForDesktopSmokeBridgeProbe(
  pluginId: string,
  featureCode: string,
  sampleIndex: number,
  iframeSrcdocBytes = 0
): Promise<DesktopSmokeBridgeProbeResult> {
  if (!isEnabled()) {
    return Promise.resolve(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-disabled"));
  }
  resolveDesktopSmokeBridgeProbe(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-superseded"));
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      resolveDesktopSmokeBridgeProbe(desktopSmokeBridgeProbeFailure("desktop-bridge-probe-timeout"));
    }, desktopSmokeBridgeProbeTimeoutMs(iframeSrcdocBytes));
    desktopSmokeBridgeProbeWaiter = {
      pluginId,
      featureCode,
      sampleIndex,
      resolve,
      timeoutId,
    };
  });
}

function handleDesktopSmokeBridgeProbe(data: Record<string, unknown>) {
  if (!desktopSmokeBridgeProbeWaiter) return;
  const pluginId = typeof data.pluginId === "string" ? data.pluginId : "";
  const featureCode = typeof data.featureCode === "string" ? data.featureCode : "";
  const sampleIndex = Number(data.sampleIndex);
  if (
    pluginId !== desktopSmokeBridgeProbeWaiter.pluginId ||
    featureCode !== desktopSmokeBridgeProbeWaiter.featureCode ||
    sampleIndex !== desktopSmokeBridgeProbeWaiter.sampleIndex
  ) {
    return;
  }
  resolveDesktopSmokeBridgeProbe(normalizeDesktopSmokeBridgeProbe(data));
}


  return {
    failure: desktopSmokeBridgeProbeFailure,
    waitFor: waitForDesktopSmokeBridgeProbe,
    receive: handleDesktopSmokeBridgeProbe,
    resolve: resolveDesktopSmokeBridgeProbe,
  };
}
