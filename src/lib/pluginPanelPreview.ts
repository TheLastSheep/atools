import type { FeatureAction } from "./types";

export function escapePluginPreviewHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function previewPayload(action: FeatureAction): Record<string, unknown> {
  return action.payload && typeof action.payload === "object"
    ? action.payload as Record<string, unknown>
    : {};
}

export function previewSubInputOptions(value: unknown): { placeholder?: string; focus?: boolean } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    placeholder: typeof record.placeholder === "string" ? record.placeholder : "",
    focus: record.focus === true,
  };
}

export function previewIframeSrc(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const isLocalHttp = (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
    return isLocalHttp || url.protocol === "file:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function previewBrowserWindowHtml(url: string, payload: Record<string, unknown>): string {
  if (typeof payload.browserWindowSrcdoc === "string") return payload.browserWindowSrcdoc;
  const safeUrl = escapePluginPreviewHtml(url);
  return `<!doctype html><html><body><main class="browser-window-smoke"><h1>Browser Window</h1><p>${safeUrl}</p><button id="browser-window-send">发送给父窗口</button><script>
    document.getElementById('browser-window-send').addEventListener('click', function() {
      window.utools.sendToParent('browser-window-message', { windowType: window.utools.getWindowType(), url: ${JSON.stringify(url)} });
      document.body.setAttribute('data-parent-message-sent', 'true');
    });
  <\/script></main></body></html>`;
}
