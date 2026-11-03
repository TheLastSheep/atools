export type FrameState = {
  tree: string;
  renderedTree: string;
  renderedTreeChars: number;
  renderedTreeOverflow: boolean;
  renderedTreeAvailable: boolean;
  hiddenChecked: boolean;
  ignoreValue: string | null;
  pageHasTauri: boolean;
  opaqueOrigin: boolean;
};

export type FixedFrameLabels = { src: boolean; buttonTsx: boolean; readmeTxt: boolean; ignoredLog: boolean; secretTxt: boolean; hidden: boolean };
export type FrameObservation = {
  modelChars: number;
  modelOverflow: boolean;
  renderedChars: number;
  renderedOverflow: boolean;
  renderedAvailable: boolean;
  modelLabels: FixedFrameLabels;
  domLabels: FixedFrameLabels;
  hiddenChecked: boolean;
  ignoreEmpty: boolean;
};
export type FrameOperation = "state" | "filter-enter" | "hidden-toggle";
export type FrameProbeDiagnostics = {
  readySeen: boolean;
  readyCurrent: boolean;
  frameObserved: boolean;
  frameLoadCount: number;
  frameLoadOverflow: boolean;
  readyPingCount: number;
  readyPingOverflow: boolean;
};
type ProbeFrame = Pick<HTMLIFrameElement, "contentWindow" | "addEventListener" | "removeEventListener">;
type ProbeOptions = {
  getFrame: () => ProbeFrame | null;
  token: string;
  onState?: (observation: FrameObservation) => void;
  timeoutMs?: number;
  eventTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
};
type ResponseMessage = Record<string, unknown>;
type ReadyIdentity = { source: Window; documentId: string };
type PendingRequest = {
  operation: FrameOperation | "ping";
  source: Window;
  documentId: string | null;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: ResponseMessage) => void;
  reject: (error: Error) => void;
};

const PROBE_KIND = "atools-file-tree-head-probe";
const RESULT_KIND = "atools-file-tree-head-result";
const READY_KIND = "atools-file-tree-head-ready";
const MAX_RENDERED_TREE_CHARS = 4096;
const MAX_DIAGNOSTIC_COUNT = 32;
const MAX_READY_PINGS = 64;
const READY_PING_WAIT_MS = 125;

export function isFrameState(value: unknown): value is FrameState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.tree === "string" && typeof state.renderedTree === "string"
    && typeof state.renderedTreeChars === "number" && Number.isFinite(state.renderedTreeChars) && state.renderedTreeChars >= 0
    && typeof state.renderedTreeOverflow === "boolean" && typeof state.renderedTreeAvailable === "boolean"
    && typeof state.hiddenChecked === "boolean" && (state.ignoreValue === null || typeof state.ignoreValue === "string")
    && typeof state.pageHasTauri === "boolean" && typeof state.opaqueOrigin === "boolean";
}

export function summarizeFrameState(state: FrameState): FrameObservation {
  const labels = (value: string): FixedFrameLabels => ({ src: value.includes("src"), buttonTsx: value.includes("Button.tsx"),
    readmeTxt: value.includes("readme.txt"), ignoredLog: value.includes("ignored.log"), secretTxt: value.includes("secret.txt"),
    hidden: value.includes(".hidden") });
  return { modelChars: Math.min(state.tree.length, MAX_RENDERED_TREE_CHARS), modelOverflow: state.tree.length > MAX_RENDERED_TREE_CHARS,
    renderedChars: Math.min(state.renderedTree.length, MAX_RENDERED_TREE_CHARS),
    renderedOverflow: state.renderedTreeOverflow || state.renderedTree.length > MAX_RENDERED_TREE_CHARS,
    renderedAvailable: state.renderedTreeAvailable, modelLabels: labels(state.tree), domLabels: labels(state.renderedTree),
    hiddenChecked: state.hiddenChecked, ignoreEmpty: state.ignoreValue === "" };
}

export function createNativeFileTreeFrameProbe(options: ProbeOptions) {
  const target = options.eventTarget ?? window;
  const pending = new Map<number, PendingRequest>();
  const waitTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const timeoutMs = options.timeoutMs ?? 5000;
  let sequence = 0;
  let currentFrame: ProbeFrame | null = null;
  let ready: ReadyIdentity | null = null;
  let readyEverSeen = false;
  let readyConfirmed = false;
  let readyCurrentAtDispose = false;
  let disposed = false;
  let frameObserved = false;
  let frameLoadCount = 0;
  let frameLoadOverflow = false;
  let readyPingCount = 0;
  let readyPingOverflow = false;
  const onFrameLoad = () => {
    ready = null;
    readyConfirmed = false;
    if (frameLoadCount < MAX_DIAGNOSTIC_COUNT) frameLoadCount += 1;
    else frameLoadOverflow = true;
  };

  function syncFrame(): Window | null {
    const frame = options.getFrame();
    if (frame !== currentFrame) {
      if (currentFrame) currentFrame.removeEventListener("load", onFrameLoad);
      currentFrame = frame;
      ready = null;
      readyConfirmed = false;
      if (currentFrame) {
        frameObserved = true;
        currentFrame.addEventListener("load", onFrameLoad);
      }
    }
    return currentFrame?.contentWindow ?? null;
  }

  function pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { waitTimers.delete(timer); resolve(); }, ms);
      waitTimers.set(timer, resolve);
    });
  }

  function rejectPending(id: number, pendingRequest: PendingRequest, error: Error) {
    clearTimeout(pendingRequest.timer);
    pending.delete(id);
    pendingRequest.reject(error);
  }

  function receive(event: MessageEvent) {
    if (disposed) return;
    const source = syncFrame();
    if (!source || event.source !== source || !event.data || typeof event.data !== "object") return;
    const message = event.data as Record<string, unknown>;
    if (message.token !== options.token) return;
    if (message.kind === READY_KIND) {
      if (typeof message.documentId === "string" && message.documentId.length > 0 && message.documentId.length <= 128) {
        ready = { source, documentId: message.documentId };
        readyConfirmed = false;
        readyEverSeen = true;
      }
      return;
    }
    if (message.kind !== RESULT_KIND || typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request || request.source !== source || request.operation !== message.operation) return;
    if (request.documentId && message.documentId !== request.documentId) {
      ready = null;
      readyConfirmed = false;
      rejectPending(message.id, request, Error("FILE_TREE_FRAME_DOCUMENT_CHANGED"));
      return;
    }
    clearTimeout(request.timer);
    pending.delete(message.id);
    request.resolve(message);
  }

  target.addEventListener("message", receive as EventListener);
  syncFrame();

  function send(operation: FrameOperation | "ping", args: Record<string, unknown>, waitMs: number, documentId: string | null): Promise<ResponseMessage> {
    const source = syncFrame();
    if (!source) return Promise.reject(Error("FILE_TREE_FRAME_NOT_READY"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`FileTree probe deadline: ${operation === "ping" ? "state" : operation}`));
      }, Math.max(1, waitMs));
      pending.set(id, { operation, source, documentId, timer, resolve, reject });
      try {
        source.postMessage({ kind: PROBE_KIND, token: options.token, id, operation, ...args }, "*");
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(Error("FILE_TREE_FRAME_POST_FAILED"));
      }
    });
  }

  async function waitForReady(deadline: number): Promise<ReadyIdentity> {
    let attempts = 0;
    while (!disposed && Date.now() < deadline && attempts < MAX_READY_PINGS) {
      const source = syncFrame();
      if (!source) throw Error("FILE_TREE_FRAME_NOT_READY");
      if (ready?.source === source && readyConfirmed) return ready;
      attempts += 1;
      if (readyPingCount < MAX_DIAGNOSTIC_COUNT) readyPingCount += 1;
      else readyPingOverflow = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const response = await send("ping", {}, Math.min(READY_PING_WAIT_MS, remaining), null);
        if (response.ready === true && typeof response.documentId === "string" && response.documentId.length > 0
          && response.documentId.length <= 128) {
          ready = { source, documentId: response.documentId };
          readyConfirmed = true;
          return ready;
        }
        await pause(Math.min(75, Math.max(1, deadline - Date.now())));
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("FileTree probe deadline: state")) throw error;
      }
    }
    if (disposed) throw Error("FILE_TREE_PROBE_DISPOSED");
    throw Error("FILE_TREE_FRAME_READY_FAILED");
  }

  async function request(operation: FrameOperation, args: Record<string, unknown> = {}): Promise<FrameState> {
    if (disposed) throw Error("FILE_TREE_PROBE_DISPOSED");
    const deadline = Date.now() + timeoutMs;
    const identity = await waitForReady(deadline);
    const attempts = operation === "state" ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const attemptBudget = operation === "state" ? Math.ceil(remaining / (attempts - attempt)) : remaining;
        const response = await send(operation, { ...args, documentId: identity.documentId }, attemptBudget, identity.documentId);
        if (typeof response.error === "string" && response.error) throw Error(response.error);
        const state: unknown = response.state;
        if (!isFrameState(state)) throw Error("FILE_TREE_FRAME_STATE_INVALID");
        if (operation === "state") options.onState?.(summarizeFrameState(state));
        return state;
      } catch (error) {
        if (operation !== "state" || attempt + 1 >= attempts || Date.now() >= deadline
          || !(error instanceof Error) || !error.message.startsWith("FileTree probe deadline: state")) throw error;
      }
    }
    throw Error(`FileTree probe deadline: ${operation}`);
  }

  function diagnostics(): FrameProbeDiagnostics {
    if (!disposed) syncFrame();
    return { readySeen: readyEverSeen, readyCurrent: disposed ? readyCurrentAtDispose : ready !== null && readyConfirmed,
      frameObserved, frameLoadCount, frameLoadOverflow, readyPingCount, readyPingOverflow };
  }

  function dispose() {
    if (disposed) return;
    readyCurrentAtDispose = ready !== null && readyConfirmed;
    const source = currentFrame?.contentWindow;
    if (source) {
      try { source.postMessage({ kind: PROBE_KIND, token: options.token, id: ++sequence, operation: "dispose",
        ...(ready ? { documentId: ready.documentId } : {}) }, "*"); } catch { /* Frame may already be gone. */ }
    }
    disposed = true;
    target.removeEventListener("message", receive as EventListener);
    if (currentFrame) currentFrame.removeEventListener("load", onFrameLoad);
    currentFrame = null;
    ready = null;
    readyConfirmed = false;
    for (const [timer, resolve] of waitTimers) {
      clearTimeout(timer);
      waitTimers.delete(timer);
      resolve();
    }
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(Error("FILE_TREE_PROBE_DISPOSED"));
      pending.delete(id);
    }
  }

  return { request, diagnostics, dispose };
}
