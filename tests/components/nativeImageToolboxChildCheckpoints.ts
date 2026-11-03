export type NativeImageToolboxChildCheckpointCode =
  | "child-csp-observer-installed"
  | "child-module-lease-script-csp-blocked"
  | "child-observer-started"
  | "child-domcontentloaded"
  | "child-enter-received"
  | "child-app-instance-present";

export type NativeImageToolboxChildCheckpoint = {
  code: NativeImageToolboxChildCheckpointCode;
  observed: boolean;
};

export type ChildCheckpointMessageTarget = Pick<Window, "addEventListener" | "removeEventListener">;
export type ChildCheckpointSource = () => MessageEventSource | null;

const MESSAGE_KIND = "atools-image-toolbox-child-checkpoint";
const MAX_MATCHING_MESSAGES = 20;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Accepts a tiny ordered protocol only from the current opaque plugin frame. */
export function listenForNativeImageToolboxChildCheckpoints(
  target: ChildCheckpointMessageTarget,
  currentFrameWindow: ChildCheckpointSource,
  onCheckpoint: (value: NativeImageToolboxChildCheckpoint) => void,
  onBudgetExhausted: () => void,
): () => void {
  let active = true;
  let matchingMessages = 0;
  let cspObserverInstalled = false;
  let moduleLeaseScriptBlocked = false;
  let observerStarted = false;
  let domContentLoaded = false;
  let enterReceived = false;
  let appPresent: boolean | undefined;

  const dispose = () => {
    if (!active) return;
    active = false;
    target.removeEventListener("message", receive);
  };

  const receive = (rawEvent: Event) => {
    if (!active) return;
    const event = rawEvent as MessageEvent<unknown>;
    if (event.origin !== "null" || event.source === null || event.source !== currentFrameWindow()) return;
    if (!record(event.data) || event.data.kind !== MESSAGE_KIND) return;
    const keys = Object.keys(event.data);
    if (keys.length !== 3 || !keys.includes("kind") || !keys.includes("code") || !keys.includes("observed")) return;
    matchingMessages += 1;
    if (matchingMessages > MAX_MATCHING_MESSAGES) {
      onBudgetExhausted();
      dispose();
      return;
    }

    const { code, observed } = event.data;
    if (typeof code !== "string" || typeof observed !== "boolean") return;
    if (code === "child-csp-observer-installed" && observed && !cspObserverInstalled) {
      cspObserverInstalled = true;
    } else if (code === "child-module-lease-script-csp-blocked" && observed
      && cspObserverInstalled && !moduleLeaseScriptBlocked) {
      moduleLeaseScriptBlocked = true;
    } else if (code === "child-observer-started" && observed && !observerStarted) {
      observerStarted = true;
    } else if (code === "child-domcontentloaded" && observed && observerStarted && !domContentLoaded) {
      domContentLoaded = true;
    } else if (code === "child-enter-received" && observed && observerStarted && !enterReceived) {
      enterReceived = true;
    } else if (code === "child-app-instance-present" && enterReceived) {
      if (appPresent === undefined && !observed) appPresent = false;
      else if (appPresent === false && observed) appPresent = true;
      else if (appPresent === undefined && observed) appPresent = true;
      else return;
    } else {
      return;
    }

    try {
      onCheckpoint({ code: code as NativeImageToolboxChildCheckpointCode, observed });
    } catch {
      // A fixture callback failure must not escape the browser message event handler.
    }
  };

  target.addEventListener("message", receive);
  return dispose;
}
