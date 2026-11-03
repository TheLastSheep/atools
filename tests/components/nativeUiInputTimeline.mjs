// Fixture-only, content-free observation. This factory is serialized into the owned frame.
// It never installs listeners or sends messages; its caller owns both lifecycles.
export function createNativeUiInputTimeline(document, window, options) {
  const capacity = 128, counterLimit = 8192;
  const eventTypes = Object.freeze(["pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "compositionstart", "compositionend"]);
  const phases = new Set(["admission", "alpha", "beta", "valid", "format", "malformed", "recovery"]);
  const context = options.context === "host" ? "host" : "plugin";
  const editorKind = ["plain", "json", "host"].includes(options.editorKind) ? options.editorKind : "host";
  const entries = [];
  let total = 0, overflow = false, stopped = false, lastElapsed = 0;
  let started = null;
  try {
    const value = window.performance.now();
    if (Number.isFinite(value)) started = value;
  } catch (_) {}
  function elapsed() {
    if (started === null) return null;
    try {
      const value = window.performance.now() - started;
      if (!Number.isFinite(value)) return null;
      lastElapsed = Math.max(lastElapsed, Math.max(0, value));
      return Math.floor(lastElapsed * 1000) / 1000;
    } catch (_) { return null; }
  }
  function query(selector) {
    try { return document.querySelector(selector); } catch (_) { return null; }
  }
  function contains(owner, target) {
    try { return !!owner && !!target && typeof owner.contains === "function" && owner.contains(target); }
    catch (_) { return false; }
  }
  function kind(target) {
    if (!target) return "unknown";
    if (target === document) return "document";
    const editor = editorKind === "plain" ? query('.cm-content[contenteditable="true"]')
      : editorKind === "json" ? query("#inputEditor textarea.inputarea") : null;
    if (editor && target === editor) return "exact-editor";
    const container = editorKind === "plain" ? query(".cm-editor")
      : editorKind === "json" ? query("#inputEditor") : null;
    if (contains(container, target) || contains(editor, target)) return "editor-container";
    if (editorKind === "json" && contains(query(".handle button"), target)) return "format-button";
    if (context === "host" && target === query("iframe.plugin-iframe")) return "host-plugin-frame";
    try { if (target === document.body) return "body"; } catch (_) {}
    return "other";
  }
  function documentFocus() {
    try {
      const value = document.hasFocus();
      return typeof value === "boolean" ? value : "unknown";
    } catch (_) { return "unknown"; }
  }
  function visibility() {
    try {
      const value = document.visibilityState;
      return value === "visible" || value === "hidden" ? value : "unknown";
    } catch (_) { return "unknown"; }
  }
  function activeKind() {
    try { return kind(document.activeElement); } catch (_) { return "unknown"; }
  }
  function append(eventType, target, trusted, composing, phase) {
    if (total < counterLimit) total++;
    else overflow = true;
    if (entries.length >= capacity) { overflow = true; return; }
    entries.push({ seq: total, elapsedMs: elapsed(), phase: phases.has(phase) ? phase : "admission",
      eventType, targetKind: kind(target), activeKind: activeKind(), isTrusted: trusted,
      documentHasFocus: documentFocus(), visibility: visibility(), isComposing: composing });
  }
  append("installed", null, "unknown", "unknown", "admission");
  return {
    eventTypes,
    observe(event, phase) {
      if (stopped) return;
      // Read only these four event properties; never inspect key, data or element content.
      const type = event.type;
      if (!eventTypes.includes(type)) return;
      const trusted = event.isTrusted, composing = event.isComposing;
      append(type, event.target, typeof trusted === "boolean" ? trusted : "unknown",
        typeof composing === "boolean" ? composing : "unknown", phase);
    },
    snapshot() {
      return { schemaVersion: 1, context, capacity, counterLimit, total, overflow, stopped,
        clock: started === null ? "unavailable" : "local-performance-now",
        entries: entries.map(entry => ({ ...entry })) };
    },
    stop() { stopped = true; },
  };
}

// The factory stays lexical to this test script; no reusable global is installed in the plugin.
export function nativeUiInputObservationSource(source) {
  return "(() => { const createNativeUiInputTimeline = (" + createNativeUiInputTimeline.toString() + ");\n" + source + "\n})();";
}
