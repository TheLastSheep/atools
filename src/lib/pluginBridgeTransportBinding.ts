/** Adapt our own legacy bridge source. Never apply this to a plugin's scripts. */
export function bindOwnPluginBridgeTransport(source: string): string {
  return source.replace(/\bwindow\.parent\.postMessage\(/g, "window.__ATOOLS_FRAME_TRANSPORT__.postLegacy(")
    .replace(/window\.addEventListener\('message', function\(e\) \{/g,
      "window.addEventListener('message', function(e) { if (!window.__ATOOLS_FRAME_TRANSPORT__.accept(e)) return;");
}

export function injectPluginHostScripts(html: string, injection: string): string {
  const match = html.match(/<head\b[^>]*>/i) ?? html.match(/<body\b[^>]*>/i);
  const doctype = !match ? html.match(/^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\b[^>]*>/i) : null;
  const index = match?.index != null ? match.index + match[0].length : doctype?.[0].length ?? 0;
  return html.slice(0, index) + injection + html.slice(index);
}
