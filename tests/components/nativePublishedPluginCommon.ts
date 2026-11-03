import registry from "../fixtures/published-plugin-cases.json";
import localRegistry from "../fixtures/local-original-plugin-cases.json";
import archiveRegistry from "../fixtures/local-original-archive-cases.json";
import inputRegistry from "../fixtures/local-original-input-cases.json";
import plainRegistry from "../fixtures/local-plain-text-cases.json";
import subnetRegistry from "../fixtures/local-subnet-calculator-cases.json";
import mybatisRegistry from "../fixtures/local-original-mybatis-cases.json";
import randomDataRegistry from "../fixtures/local-original-random-data-cases.json";
import convertedRegistry from "../fixtures/converted-source-cases.json";
import { IMAGE_STITCH_PROFILE } from "./nativePublishedImageStitchContract";
import { convertFileSrc, invoke as rawInvoke } from "@tauri-apps/api/core";
import { verifyConvertedHandoffEvidence } from "./nativeConvertedHandoff";
import type { DesktopSmokeDeepReadActivation, DesktopSmokeImageStitchActivation } from "../../src/lib/desktopSmokeFilesActivationContract";

export type PublishedPluginProfile = {
  caseId: string; id: string; version: string; archiveSha256?: string; directorySha256?: string; fileCount: number;
  sourceCommit?: string; sourceTree?: string;
  sourceKind?: "local_full_directory" | "local_original_archive" | "converted_handoff_directory"; sourcePath?: string;
  verifyDataPersistence?: boolean; dialogAccess?: "none" | "open" | "save" | "open_and_save";
  featureCode: string; searchQuery: string; title: string; runtime: "node" | "web"; dataAccess: boolean; pathAccess: "none" | "standard";
  sourceReview?: string; sourceReviewStatus?: string; frameOperations: string;
};
export type PublishedFixture = {
  token: string; pluginRoot?: string; assetProbePath?: string; runId: string;
  packageSha256: string; profile: PublishedPluginProfile;
  workerContractOnly?: boolean;
  nativeUiInput?: boolean;
  requireForeground?: true;
  deepReadTextEncoding?: "utf8-bom";
  packageImportPath?: string;
  convertedHandoff?: import("./nativeConvertedHandoff").ConvertedHandoffEvidence;
};
export type RuntimeState = {
  resourceLeases: number; legacySessions: number; legacyOpenings: number; legacyTransport: boolean; pendingRequests: number;
  hostSessions: number; hostIntents: number; hostInvocations: number; hostTransport: boolean;
  dataSessions: number; dataIntents: number; dataInvocations: number; dataPreparations: number; dataTransport: boolean;
  pathRuntimeAvailable: boolean; activePathSnapshots: number; activePathIntents: number; activePathPreparations: number; pathSnapshotBytes: number;
  dialogSessions: number; dialogIntents: number; dialogInvocations: number; dialogPreparations: number; nativeDialogs: number; dialogTransport: boolean;
  displayRuntimeAvailable: boolean; displaySessions: number; displayIntents: number; displayInvocations: number;
};
export type TaskRun = { id: string; capabilityId: string; status: string; summary?: string };
export type ObservedTaskRun = Pick<TaskRun, "id" | "capabilityId" | "status"> & {
  input: unknown;
  initiator: { type: string; clientId?: string | null };
};
export type PublishedBusinessResult = { tested: string[]; notTested: string[]; [key: string]: unknown };
export type PublishedFilesActivation = DesktopSmokeDeepReadActivation & DesktopSmokeImageStitchActivation;
export type PublishedScenarioContext = {
  profile: PublishedPluginProfile; fixture: PublishedFixture;
  check: (ok: unknown, label: string) => void;
  until: <T>(read: () => T | Promise<T>, label: string) => Promise<NonNullable<T>>;
  pause: (ms?: number) => Promise<void>;
  probe: <T>(operation: string, extra?: Record<string, unknown>) => Promise<T>;
  setPhase: (phase: string) => void; observations: Record<string, unknown>;
  activateFilesFeature?: PublishedFilesActivation;
  passivePluginReturn?: { markAttempted: () => void; observeSettled: () => Promise<void> };
  deepReadExpectedProgressIndex?: number;
  deepReadExpectedProgressIndicatorWidth?: string;
};
export const invoke = <T>(command: string, args?: Record<string, unknown>) => rawInvoke<T>(command, args);
export const pause = (ms = 40) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function until<T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = performance.now() + 10000;
  while (performance.now() < end) { const value = await read(); if (value) return value as NonNullable<T>; await pause(); }
  throw Error(label);
}
export function verifyFixtureProfile(fixture: PublishedFixture) {
  const expected = [...registry.cases, ...localRegistry.cases, ...archiveRegistry.cases, ...inputRegistry.cases,
    ...plainRegistry.cases, ...subnetRegistry.cases, ...mybatisRegistry.cases, ...randomDataRegistry.cases, ...convertedRegistry.cases,
    IMAGE_STITCH_PROFILE]
    .find(item => item.caseId === fixture.profile?.caseId);
  const sameProfile = expected && Object.keys(expected).length === Object.keys(fixture.profile).length
    && Object.entries(expected).every(([key, value]) => fixture.profile[key as keyof PublishedPluginProfile] === value);
  const expectedDigest = expected && ("directorySha256" in expected ? expected.directorySha256 : expected.archiveSha256);
  if (!expected || !sameProfile
    || Object.hasOwn(fixture, "deepReadTextEncoding")
      && (expected.caseId !== "converted-deepread-source" || fixture.deepReadTextEncoding !== "utf8-bom")
    || fixture.workerContractOnly !== undefined && typeof fixture.workerContractOnly !== "boolean"
    || fixture.workerContractOnly === true && expected?.caseId !== "local-json-editor"
    || Object.hasOwn(fixture, "requireForeground") && fixture.requireForeground !== true
    || fixture.packageSha256 !== expectedDigest || !fixture.runId || !fixture.token) {
    throw Error("Rust fixture returned an unknown profile, SHA or missing run identity");
  }
  if (fixture.profile.sourceKind === "converted_handoff_directory") {
    const exactConvertedKeys = ["token", "runId", "packageSha256", "profile", "workerContractOnly", "nativeUiInput", "convertedHandoff",
      ...(fixture.requireForeground === true ? ["requireForeground"] : []),
      ...(Object.hasOwn(fixture, "deepReadTextEncoding") ? ["deepReadTextEncoding"] : [])];
    if (Object.keys(fixture).length !== exactConvertedKeys.length
      || !exactConvertedKeys.every(key => Object.hasOwn(fixture, key))
      || fixture.pluginRoot !== undefined || fixture.assetProbePath !== undefined || fixture.packageImportPath !== undefined
      || fixture.workerContractOnly === true || fixture.nativeUiInput === true) {
      throw Error("Converted fixture exposed a path or unrelated native mode to the renderer");
    }
    verifyConvertedHandoffEvidence(fixture.convertedHandoff, fixture.profile, fixture.packageSha256);
  } else if (!fixture.pluginRoot || !fixture.assetProbePath || fixture.convertedHandoff !== undefined) {
    throw Error("Registered package fixture paths or conversion evidence are missing");
  }
  return fixture.profile;
}
export const launcherInput = () => document.querySelector<HTMLInputElement>(".search-input");
export const permissionDialog = () => document.querySelector<HTMLElement>("[data-permission-dialog]");
export function blockingPublishedDiagnostics<T extends { event: string }>(diagnostics: T[]) {
  return diagnostics.filter(item => ["securitypolicyviolation", "resource-load-error", "uncaught-error", "unhandled-rejection", "console-error"].includes(item.event));
}
export type PreparedScriptEvidence = { type: string; external: boolean; fixtureResource: boolean;
  preparedSourceMatches: boolean; resourceTransport: "inline" | "asset" | "lease" | "remote" | "invalid-lease";
  publicPathResource?: { resourceTransport: string; sourceMatches: boolean };
  inlineModuleImports: Array<{ resourceTransport: string; sourceMatches: boolean }>; inlineModuleImportsValid: boolean };
export type PublishedFrameIsolation = {
  scripts?: PreparedScriptEvidence[]; preparedResourceLeaseCount?: number;
  origin: string; parentDocumentAccessBlocked: boolean; tauriInternalsType: string; globalTauriType: string;
};
/** Prepared external modules and rewritten inline dependencies share the panel's one lazy lease. */
export function preparedResourceLeaseExpectation(frame: Pick<PublishedFrameIsolation, "scripts" | "preparedResourceLeaseCount">): 0 | 1 {
  if (!Array.isArray(frame.scripts) || frame.scripts.length === 0
    || ![0, 1].includes(frame.preparedResourceLeaseCount ?? -1)) throw Error("Missing or invalid prepared resource evidence");
  let hasLease = false;
  for (const script of frame.scripts) {
    if (typeof script.type !== "string" || typeof script.external !== "boolean" || typeof script.fixtureResource !== "boolean"
      || typeof script.preparedSourceMatches !== "boolean"
      || !["inline", "asset", "lease", "remote"].includes(script.resourceTransport)
      || !Array.isArray(script.inlineModuleImports) || script.inlineModuleImportsValid !== true) throw Error("Incomplete prepared script evidence");
    if ((script.resourceTransport === "inline") === script.external
      || (script.external && script.fixtureResource && !script.preparedSourceMatches)) throw Error("Prepared script source metadata is inconsistent");
    if (script.resourceTransport === "lease") {
      if (script.type !== "module" || !script.external || !script.fixtureResource || !script.preparedSourceMatches)
        throw Error("Prepared lease script identity does not match its resource marker");
      hasLease = true;
    } else if (script.type === "module" && script.external && script.fixtureResource) {
      throw Error("Prepared external module does not use its resource lease");
    }
    if (script.publicPathResource) {
      if (script.external || !script.fixtureResource || script.publicPathResource.resourceTransport !== "lease"
        || !script.publicPathResource.sourceMatches) throw Error("Prepared automatic public path is not bound to its inline bundle lease");
      hasLease = true;
    }
    for (const dependency of script.inlineModuleImports) {
      if (script.type !== "module" || script.external || !dependency.sourceMatches
        || !["asset", "lease"].includes(dependency.resourceTransport)) throw Error("Prepared inline module dependency does not match its rewritten source");
      if (dependency.resourceTransport === "lease") hasLease = true;
    }
  }
  const expected = hasLease ? 1 : 0;
  if (frame.preparedResourceLeaseCount !== expected) throw Error("Prepared scripts disagree with their unique resource lease count");
  return expected;
}
export function verifyPublishedFrameIsolation(frame: HTMLIFrameElement, state: PublishedFrameIsolation,
  check: PublishedScenarioContext["check"]) {
  const sandbox = (frame.getAttribute("sandbox") || "").split(/\s+/).filter(Boolean);
  check(sandbox.includes("allow-scripts") && !sandbox.includes("allow-same-origin"),
    "Production plugin iframe allows scripts while retaining opaque sandbox isolation");
  check(state.origin === "null" && state.parentDocumentAccessBlocked === true,
    "Original plugin frame has opaque origin and cannot read the parent document");
  check(state.tauriInternalsType === "undefined" && state.globalTauriType === "undefined",
    "Original plugin frame cannot directly access Tauri internals or the global Tauri API");
  return { sandbox, ...state };
}
export function runtimeDrained(value: RuntimeState) {
  return value.resourceLeases === 0 && value.legacySessions === 0 && value.legacyOpenings === 0 && !value.legacyTransport
    && value.pendingRequests === 0 && value.hostSessions === 0 && value.hostIntents === 0
    && value.hostInvocations === 0 && !value.hostTransport && dataRuntimeDrained(value)
    && value.pathRuntimeAvailable === true && value.activePathSnapshots === 0 && value.activePathIntents === 0
    && value.activePathPreparations === 0 && value.pathSnapshotBytes === 0
    && value.dialogSessions === 0 && value.dialogIntents === 0 && value.dialogInvocations === 0
    && value.dialogPreparations === 0 && value.nativeDialogs === 0 && value.dialogTransport === false
    && value.displaySessions === 0 && value.displayIntents === 0 && value.displayInvocations === 0;
}
export function dataRuntimeDrained(value: RuntimeState) {
  return value.dataSessions === 0 && value.dataIntents === 0 && value.dataInvocations === 0
    && value.dataPreparations === 0 && !value.dataTransport;
}
export function publishedPathsReady(value: RuntimeState, access: PublishedPluginProfile["pathAccess"]) {
  return value.pathRuntimeAvailable === true && value.activePathIntents === 0 && value.activePathPreparations === 0
    && (access === "standard" ? value.activePathSnapshots === 1 && value.pathSnapshotBytes > 0 && value.pathSnapshotBytes <= 128 * 1024
      : value.activePathSnapshots === 0 && value.pathSnapshotBytes === 0);
}
/** Approve the exact standard metadata capability through the real permission dialog, before Node starts. */
export async function approvePublishedStandardPaths(context: PublishedScenarioContext) {
  const { until, check } = context;
  const request = await until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    if (!title.includes("请求读取常用目录路径") || !title.includes(context.profile.title)) return null;
    const pending = await invoke<Array<{ tool_name: string; client_id: string; scopes: string[] }>>("list_pending_agent_requests");
    return pending.length === 1 && /^atools\.host\.paths\.[a-f0-9]{24}\.standard$/.test(pending[0].tool_name)
      && pending[0].client_id === "atools-ui" && pending[0].scopes.length === 1 && pending[0].scopes[0] === "file_read" ? pending[0] : null;
  }, "Original plugin did not request its exact standard-path metadata permission before Node startup");
  const before = await invoke<RuntimeState>("native_published_runtime_state");
  const dataReady = context.profile.dataAccess
    ? before.dataSessions === 1 && before.dataTransport && before.dataIntents === 0
      && before.dataInvocations === 0 && before.dataPreparations === 0 : dataRuntimeDrained(before);
  check(before.legacySessions === 0 && before.legacyOpenings === 0 && !before.legacyTransport && dataReady
    && before.hostSessions === 0 && before.hostIntents === 0 && before.hostInvocations === 0 && !before.hostTransport
    && before.pendingRequests === 1 && before.activePathSnapshots === 0 && before.pathSnapshotBytes === 0,
    "Standard-path approval retains only previously approved data and starts no Node, clipboard runtime or path snapshot");
  check(!document.querySelector('iframe[title="Plugin"]'), "Original plugin page waits before standard-path approval");
  const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "允许一次");
  check(allow, "Standard directory metadata requires an explicit fresh one-time approval"); allow!.click();
  await until(() => !permissionDialog()?.querySelector("h2")?.textContent?.includes("请求读取常用目录路径"), "Standard-path authorization did not finish");
  return { before, capability: request.tool_name, scope: "file_read", realPathsRecorded: false };
}
/** A Web preload can own approved SQLite data without owning any Node or clipboard runtime. */
export function publishedWebRuntimeReady(value: RuntimeState, dataAccess: boolean) {
  return runtimeDrained({ ...value, resourceLeases: 0, dataSessions: 0, dataTransport: false })
    && (dataAccess ? value.dataSessions === 1 && value.dataTransport : dataRuntimeDrained(value));
}
export async function approvePublishedData(context: PublishedScenarioContext, label: string) {
  const { until, check } = context;
  await until(() => permissionDialog()?.querySelector("h2")?.textContent?.includes("请求访问自己的数据"),
    label + " did not request real plugin data authorization before page startup");
  const before = await invoke<RuntimeState>("native_published_runtime_state");
  check(before.dataSessions === 0 && !before.dataTransport && before.legacySessions === 0 && before.pendingRequests === 1,
    label + " waits for approval before starting a data listener, Node preload or page");
  check(!document.querySelector('iframe[title="Plugin"]'), label + " page waits until actual data approval");
  const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "允许一次");
  check(allow, label + " requires explicit one-time data authorization"); allow!.click();
  await until(() => !permissionDialog()?.querySelector("h2")?.textContent?.includes("请求访问自己的数据"),
    label + " data authorization did not finish");
  return before;
}
export async function verifyAssetProtocolDefer(context: Pick<PublishedScenarioContext, "check" | "observations">, path: string) {
  const { check, observations } = context, source = convertFileSrc(path);
  check(source.startsWith("asset://localhost/"), "Fixture converts its isolated local asset through the real Tauri asset URL API");
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts"); frame.setAttribute("title", "isolated local asset protocol probe"); frame.hidden = true;
  const escaped = source.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  frame.srcdoc = `<!doctype html><html><head><script defer src="${escaped}"></script></head><body><div id="asset-probe-root">parsed-before-defer</div></body></html>`;
  const response = await new Promise<{ rootFound: boolean; rootText: string; readyState: string; origin: string }>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); frame.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(Error("Tauri asset-protocol defer script did not report")); }, 5000);
    function receive(event: MessageEvent) {
      if (event.source !== frame.contentWindow || event.data?.kind !== "atools-asset-defer-result") return;
      cleanup(); resolve(event.data);
    }
    window.addEventListener("message", receive); document.body.append(frame);
  });
  check(response.rootFound && response.rootText === "parsed-before-defer", "Real local asset-protocol external defer script runs after parsing in sandbox without same-origin");
  check(response.origin === "null", "Asset protocol defer probe retains the production opaque iframe origin");
  observations.assetProtocolDefer = { urlScheme: "asset://localhost", ...response, sandbox: "allow-scripts", networkRequests: 0 };
}
type FrameReady = { documentNonce: string; documentUrl: string; documentState: string; attempts: number };
const authenticatedDocuments = new WeakMap<object, string>();
/** Ephemeral fixture identity; never inferred from a URL, DOM node or diagnostic text. */
export const currentPublishedFrameDocument = (context: Pick<PublishedScenarioContext, "observations">) => authenticatedDocuments.get(context.observations);
const FRAME_PROBE_TIMEOUT_MS = 5000, FRAME_READY_RETRY_MS = 50;

/** Only the read-only readiness request is repeated. Every business operation is sent exactly once. */
export function createFrameProbe(context: Pick<PublishedScenarioContext, "fixture" | "check" | "observations">) {
  let sequence = 0;
  return async function probe<T>(operation: string, extra: Record<string, unknown> = {}): Promise<T> {
    if (!operation || ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"].some(key => Object.hasOwn(extra, key))) {
      throw Error("Reserved or missing published probe transport identity");
    }
    const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Published iframe missing");
    const source = frame.contentWindow, srcdoc = frame.srcdoc;
    if (!source || !srcdoc) throw Error("Published iframe has no current srcdoc document");
    const id = "published-" + (++sequence), token = context.fixture.token, caseId = context.fixture.profile.caseId;
    const current = () => document.querySelector('iframe[title="Plugin"]') === frame
      && frame.contentWindow === source && frame.srcdoc === srcdoc;
    const ready = await new Promise<FrameReady>((resolve, reject) => {
      let attempts = 0, settled = false, retry: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); clearTimeout(retry); window.removeEventListener("message", receive); };
      const finish = (error?: Error, value?: FrameReady) => {
        if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => finish(Error("Published frame readiness timeout: " + operation)), FRAME_PROBE_TIMEOUT_MS);
      function receive(event: MessageEvent) {
        const message = event.data;
        if (event.source !== source || message?.kind !== "atools-published-probe-ready-result" || message.token !== token
          || message.id !== id || message.caseId !== caseId || message.operation !== "ready") return;
        if (!current()) { finish(Error("Published iframe changed during readiness")); return; }
        if (message.ready !== true || message.documentUrl !== "about:srcdoc" || !["interactive", "complete"].includes(message.documentState)
          || typeof message.documentNonce !== "string" || !/^[a-f0-9]{32}$/.test(message.documentNonce)) return;
        finish(undefined, { documentNonce: message.documentNonce, documentUrl: message.documentUrl, documentState: message.documentState, attempts });
      }
      function sendReady() {
        if (settled) return;
        if (!current()) { finish(Error("Published iframe changed during readiness")); return; }
        attempts++;
        try { source!.postMessage({ kind: "atools-published-probe-ready", token, id, caseId, operation: "ready" }, "*"); }
        catch { finish(Error("Published frame readiness transport failed")); return; }
        if (!settled) retry = setTimeout(sendReady, FRAME_READY_RETRY_MS);
      }
      window.addEventListener("message", receive); sendReady();
    });
    const workerLeaseSessions = context.fixture.profile.caseId === "local-json-editor"
      ? await invoke<string[]>("native_published_resource_sessions") : [];
    const response = await new Promise<{ state: T; error?: string }>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); };
      const timer = setTimeout(() => { cleanup(); reject(Error("Published frame operation timeout (not replayed): " + operation)); }, FRAME_PROBE_TIMEOUT_MS);
      function receive(event: MessageEvent) {
        const message = event.data;
        if (event.source !== source || message?.kind !== "atools-published-probe-result" || message.token !== token || message.id !== id
          || message.caseId !== caseId || message.operation !== operation || message.documentNonce !== ready.documentNonce) return;
        cleanup(); if (!current()) reject(Error("Published iframe changed during operation")); else resolve(message);
      }
      window.addEventListener("message", receive);
      if (!current()) { cleanup(); reject(Error("Published iframe changed before operation")); return; }
      try { source.postMessage({ ...extra, kind: "atools-published-probe", token, id, caseId, operation, documentNonce: ready.documentNonce, workerLeaseSessions }, "*"); }
      catch { cleanup(); reject(Error("Published frame operation transport failed (not replayed): " + operation)); }
    });
    context.observations.lastFrameProbe = { operation, error: response.error || null, state: response.state,
      readiness: { attempts: ready.attempts, documentUrl: ready.documentUrl, documentState: ready.documentState, documentNonceBound: true } };
    authenticatedDocuments.set(context.observations, ready.documentNonce);
    const label = operation === "path-contract" || operation === "preload-write-synthetic-text" ? "Reviewed preload contract operation succeeds: " : "Reviewed UI operation succeeds: ";
    context.check(!response.error, label + operation);
    return response.state;
  };
}
