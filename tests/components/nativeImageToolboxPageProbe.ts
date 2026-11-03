export type NativeImageToolboxObservationCode =
  | "top-window-observers-installed"
  | "frame-observer-installed"
  | "frame-presence-after-tick"
  | "frame-source-assigned-after-tick"
  | "frame-source-attribute-assigned"
  | "frame-load-after-source-attribute-mutation"
  | "panel-load-error-observer-installed"
  | "panel-load-error"
  | "top-window-error"
  | "top-unhandled-rejection";

export type NativeImageToolboxObservationSink = (
  code: NativeImageToolboxObservationCode,
  observed?: boolean,
) => void;

const MAX_OBSERVATIONS = 12;
const MAX_MUTATION_RECORDS = 128;
const MAX_ADDED_NODES = 64;
const PLUGIN_FRAME = 'iframe[title="Plugin"]';

/** Bounded, value-free top-page evidence for the Image-Toolbox fixture. */
export function createNativeImageToolboxPageProbe(
  documentRef: Document,
  windowRef: Window & typeof globalThis,
  emit: NativeImageToolboxObservationSink,
) {
  let active = false;
  let observer: MutationObserver | undefined;
  let currentFrame: HTMLIFrameElement | undefined;
  let frameLoadHandler: (() => void) | undefined;
  const observed = new Set<string>();
  const sourceMutationSeen = new WeakSet<HTMLIFrameElement>();
  let inspectedMutationRecords = 0;
  let inspectedAddedNodes = 0;

  const report = (code: NativeImageToolboxObservationCode, value?: boolean) => {
    if (!active) return;
    const key = `${code}:${value === undefined ? "unknown" : String(value)}`;
    if (observed.has(key) || observed.size >= MAX_OBSERVATIONS) return;
    observed.add(key);
    emit(code, value);
  };

  const hasEntryAttribute = (frame: HTMLIFrameElement) =>
    frame.hasAttribute("src") || frame.hasAttribute("srcdoc");

  const attachFrame = (frame: HTMLIFrameElement) => {
    if (hasEntryAttribute(frame) && !sourceMutationSeen.has(frame)) {
      sourceMutationSeen.add(frame);
      report("frame-source-attribute-assigned", true);
    }
    if (frame !== currentFrame) {
      if (currentFrame && frameLoadHandler) currentFrame.removeEventListener("load", frameLoadHandler);
      currentFrame = frame;
      frameLoadHandler = () => {
        // A bare initial about:blank load is not a plugin load or a readiness signal.
        if (sourceMutationSeen.has(frame) && hasEntryAttribute(frame)) {
          report("frame-load-after-source-attribute-mutation", true);
        }
      };
      frame.addEventListener("load", frameLoadHandler);
    }
  };

  const findFrame = (root: ParentNode): HTMLIFrameElement | undefined => {
    const candidate = root.querySelector(PLUGIN_FRAME);
    return candidate instanceof windowRef.HTMLIFrameElement ? candidate : undefined;
  };

  const inspectAddedNode = (node: Node) => {
    if (!(node instanceof windowRef.Element)) return;
    const frame = node.matches(PLUGIN_FRAME) ? node : findFrame(node);
    if (frame instanceof windowRef.HTMLIFrameElement) attachFrame(frame);
  };

  const disconnectMutationObserver = () => {
    observer?.disconnect();
    observer = undefined;
  };

  const onMutations: MutationCallback = (records) => {
    if (!active) return;
    for (const mutation of records) {
      if (inspectedMutationRecords >= MAX_MUTATION_RECORDS) {
        disconnectMutationObserver();
        return;
      }
      inspectedMutationRecords += 1;
      if (mutation.type === "attributes" && mutation.target instanceof windowRef.HTMLIFrameElement) {
        const frame = mutation.target;
        if (frame.matches(PLUGIN_FRAME) && (mutation.attributeName === "src" || mutation.attributeName === "srcdoc")) {
          if (hasEntryAttribute(frame)) {
            sourceMutationSeen.add(frame);
            report("frame-source-attribute-assigned", true);
          }
          attachFrame(frame);
        }
      } else if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (inspectedAddedNodes >= MAX_ADDED_NODES) {
            disconnectMutationObserver();
            return;
          }
          inspectedAddedNodes += 1;
          inspectAddedNode(node);
        }
      }
    }
    if (inspectedMutationRecords >= MAX_MUTATION_RECORDS || inspectedAddedNodes >= MAX_ADDED_NODES) {
      disconnectMutationObserver();
    }
  };

  const onWindowError = () => report("top-window-error", true);
  const onUnhandledRejection = () => report("top-unhandled-rejection", true);

  return {
    install() {
      if (active) return;
      active = true;
      windowRef.addEventListener("error", onWindowError);
      windowRef.addEventListener("unhandledrejection", onUnhandledRejection);
      report("top-window-observers-installed");
      report("frame-observer-installed");
      const initialFrame = findFrame(documentRef);
      if (initialFrame) attachFrame(initialFrame);
      observer = new windowRef.MutationObserver(onMutations);
      observer.observe(documentRef.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcdoc"],
      });
    },
    snapshotAfterTick() {
      if (!active) return;
      const frame = findFrame(documentRef);
      if (frame) attachFrame(frame);
      report("frame-presence-after-tick", frame !== undefined);
      report("frame-source-assigned-after-tick", frame ? hasEntryAttribute(frame) : false);
    },
    markPanelLoadErrorHandlerInstalled() {
      report("panel-load-error-observer-installed");
    },
    markPanelLoadError() {
      report("panel-load-error", true);
    },
    dispose() {
      if (!active) return;
      active = false;
      observer?.disconnect();
      observer = undefined;
      if (currentFrame && frameLoadHandler) currentFrame.removeEventListener("load", frameLoadHandler);
      currentFrame = undefined;
      frameLoadHandler = undefined;
      windowRef.removeEventListener("error", onWindowError);
      windowRef.removeEventListener("unhandledrejection", onUnhandledRejection);
    },
  };
}
