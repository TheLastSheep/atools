/**
 * Creates a page-owned, isolated notice for failed plugin data mutations.
 * Keep this function self-contained: the plugin bridge serializes it into the
 * document before third-party preload and page code run.
 */
export function createPluginDataOperationFeedback() {
  let closed = false;
  let waitingForDocument = false;
  let host: HTMLElement | undefined;
  let previousFocus: Element | null = null;
  let dismissButton: HTMLButtonElement | undefined;

  function removeDomReadyListener() {
    if (!waitingForDocument) return;
    waitingForDocument = false;
    document.removeEventListener("DOMContentLoaded", show, false);
  }

  function removeNotice(restoreFocus: boolean) {
    const shouldRestore = restoreFocus && !!dismissButton
      && host?.shadowRoot?.activeElement === dismissButton;
    const returnTarget = previousFocus;
    host?.remove();
    host = undefined;
    dismissButton = undefined;
    previousFocus = null;
    if (shouldRestore && returnTarget?.isConnected && typeof (returnTarget as HTMLElement).focus === "function") {
      (returnTarget as HTMLElement).focus({ preventScroll: true });
    }
  }

  function dismiss() {
    removeNotice(true);
  }

  function show() {
    if (closed || host) return;
    const root = document.documentElement;
    if (!root) {
      if (!waitingForDocument) {
        waitingForDocument = true;
        document.addEventListener("DOMContentLoaded", show, { once: true });
      }
      return;
    }
    removeDomReadyListener();

    const previous = document.activeElement;
    previousFocus = previous && previous !== document.body ? previous : null;
    const element = document.createElement("div");
    element.setAttribute("data-atools-data-operation-feedback", "");
    element.setAttribute("style", "all:initial!important;position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483647!important;display:block!important;pointer-events:none!important;");
    const shadow = element.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .notice {
        box-sizing: border-box; display: flex; align-items: flex-start; gap: 10px;
        width: min(420px, calc(100vw - 24px)); max-width: 420px; min-height: 52px;
        padding: 12px 12px 12px 14px; border: 1px solid #b42318; border-left-width: 4px;
        border-radius: 10px; background: #fff; color: #1f2937;
        box-shadow: 0 8px 28px rgb(0 0 0 / 20%); pointer-events: none;
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .message { flex: 1 1 auto; min-width: 0; }
      button {
        flex: 0 0 auto; min-width: 28px; min-height: 28px; margin: -2px -2px 0 0;
        padding: 0; border: 0; border-radius: 6px; background: transparent; color: inherit;
        font: inherit; font-size: 20px; line-height: 1; cursor: pointer; pointer-events: auto;
      }
      button:hover { background: rgb(0 0 0 / 8%); }
      button:focus-visible { outline: 2px solid #1d4ed8; outline-offset: 2px; }
      @media (prefers-color-scheme: dark) {
        .notice { border-color: #f97066; background: #242424; color: #f4f4f5; }
        button:hover { background: rgb(255 255 255 / 12%); }
        button:focus-visible { outline-color: #93c5fd; }
      }
      @media (forced-colors: active) {
        .notice { border: 2px solid CanvasText; background: Canvas; color: CanvasText; }
        button:focus-visible { outline-color: Highlight; }
      }
    `;
    const alert = document.createElement("div");
    alert.className = "notice";
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "assertive");
    alert.setAttribute("aria-atomic", "true");
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = "ATools：数据写入未完成，请在插件中重试。";
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", "关闭数据错误提示");
    button.textContent = "×";
    button.addEventListener("click", dismiss);
    alert.append(message, button);
    shadow.append(style, alert);
    host = element;
    dismissButton = button;
    root.append(element);
  }

  return {
    failed() {
      if (closed) return;
      show();
    },
    resolved() {
      if (closed) return;
      removeDomReadyListener();
      removeNotice(true);
    },
    close() {
      if (closed) return;
      closed = true;
      removeDomReadyListener();
      removeNotice(false);
    },
  };
}
