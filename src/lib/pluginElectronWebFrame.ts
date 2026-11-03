/**
 * Document-local subset of Electron webFrame. CSS zoom does not reproduce
 * Chromium's origin-wide zoom, device scale, or every layout side effect.
 * Keep this factory self-contained because the production adapter serializes it.
 */
export function createPluginElectronWebFrame(document: Document) {
  let zoomFactor = 1;
  let requestedZoomFactor: number | null = null;
  let pending = false;
  let active = true;
  const frameWindow = document.defaultView;

  function removePendingListeners() {
    if (!pending) return;
    document.removeEventListener("DOMContentLoaded", onDocumentReady);
    frameWindow?.removeEventListener("pagehide", onPageHide);
    pending = false;
  }

  function reportDeferredFailure(error: unknown) {
    try {
      frameWindow?.console.error("[ATools electron webFrame.setZoomFactor]", error);
    } catch { /* Diagnostics must not create a second failure. */ }
  }

  function applyZoom(root: HTMLElement, value: number) {
    const previousStyle = root.style.zoom;
    const nextStyle = String(value);
    try {
      root.style.zoom = nextStyle;
      if (root.style.zoom !== nextStyle) throw new Error("CSS zoom declaration rejected the requested factor");
    } catch (error) {
      try { root.style.zoom = previousStyle; } catch { /* Preserve the original application failure. */ }
      throw error;
    }
  }

  function validateCssZoom(value: number) {
    const style = document.createElement("div").style;
    const nextStyle = String(value);
    style.zoom = nextStyle;
    if (style.zoom !== nextStyle) throw new Error("CSS zoom declaration rejected the requested factor");
  }

  function onPageHide() {
    removePendingListeners();
    requestedZoomFactor = null;
    active = false;
  }

  function onDocumentReady() {
    removePendingListeners();
    if (!active) return;
    const requested = requestedZoomFactor;
    requestedZoomFactor = null;
    if (requested === null) return;
    const root = document.documentElement;
    if (!root) {
      active = false;
      reportDeferredFailure(new Error("webFrame document root was unavailable at DOMContentLoaded"));
      return;
    }
    try {
      applyZoom(root, requested);
      zoomFactor = requested;
    } catch (error) {
      reportDeferredFailure(error);
    }
  }

  function scheduleDocumentReady() {
    if (pending) return;
    if (!frameWindow) throw new Error("webFrame current document window is unavailable");
    document.addEventListener("DOMContentLoaded", onDocumentReady);
    try {
      frameWindow.addEventListener("pagehide", onPageHide);
      pending = true;
    } catch (error) {
      document.removeEventListener("DOMContentLoaded", onDocumentReady);
      throw error;
    }
  }

  function setZoomFactor(value: number): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RangeError("webFrame.setZoomFactor requires a finite number greater than zero");
    }
    if (!active) throw new Error("webFrame document is no longer active");
    const root = document.documentElement;
    if (!root) {
      validateCssZoom(value);
      scheduleDocumentReady();
      requestedZoomFactor = value;
      return;
    }
    applyZoom(root, value);
    if (pending) {
      removePendingListeners();
      requestedZoomFactor = null;
    }
    zoomFactor = value;
  }

  function getZoomFactor(): number {
    return zoomFactor;
  }

  return { setZoomFactor, getZoomFactor };
}
