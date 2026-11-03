// Installed only by the explicit isolated local-plain-text native-ui-input fixture.
(() => {
  const phases = new Set(["alpha", "beta"]);
  const records = Object.create(null);
  let phase = null, stopped = false;
  const timeline = createNativeUiInputTimeline(document, window, { context: "plugin", editorKind: "plain" });
  const empty = () => ({ trustedEditorPointers: 0, trustedKeydowns: 0, trustedBeforeInputs: 0,
    trustedInputs: 0, rejectedUntrusted: 0, overflow: false, diagnostics: diagnostics() });
  function diagnostics() {
    return { schemaVersion: 2, composition: { starts: 0, ends: 0, active: false },
      composingEvents: { yes: 0, no: 0, unknown: 0 }, lastEditingIsComposing: "unknown",
      editingContexts: { visibleFocusedEditor: 0, visibleUnfocusedEditor: 0, visibleOtherFocus: 0, hidden: 0, unknown: 0 },
      lastEditingContext: "unknown",
      inputTypes: { insertText: 0, insertCompositionText: 0, insertFromComposition: 0, insertLineBreak: 0,
        insertParagraph: 0, deletion: 0, history: 0, other: 0, missing: 0 },
      targets: { pointerdown: { editor: 0, container: 0, outside: 0 },
        mousedown: { editor: 0, container: 0, outside: 0 }, click: { editor: 0, container: 0, outside: 0 } } };
  }
  function count(record, counters, key) {
    if (counters[key] >= 8192) record.overflow = true;
    else counters[key]++;
  }
  function increment(record, key) { count(record, record, key); }
  function inputType(value) {
    if (typeof value !== "string" || !value) return "missing";
    if (["insertText", "insertCompositionText", "insertFromComposition", "insertLineBreak", "insertParagraph"].includes(value)) return value;
    if (value.startsWith("delete")) return "deletion";
    if (value === "historyUndo" || value === "historyRedo") return "history";
    return "other";
  }
  function editingContext(editor) {
    try {
      if (document.hidden || document.visibilityState === "hidden") return "hidden";
      if (document.visibilityState !== "visible" || typeof document.hasFocus !== "function") return "unknown";
      const focused = document.hasFocus();
      if (typeof focused !== "boolean") return "unknown";
      if (document.activeElement !== editor) return "visibleOtherFocus";
      return focused ? "visibleFocusedEditor" : "visibleUnfocusedEditor";
    } catch (_) { return "unknown"; }
  }
  function editingDiagnostics(event, record, editor) {
    const value = record.diagnostics;
    if (event.type === "compositionstart") { count(record, value.composition, "starts"); value.composition.active = true; }
    if (event.type === "compositionend") { count(record, value.composition, "ends"); value.composition.active = false; }
    if (event.type === "beforeinput" || event.type === "input") {
      const composing = event.isComposing === true ? "yes" : event.isComposing === false ? "no" : "unknown";
      count(record, value.composingEvents, composing);
      value.lastEditingIsComposing = composing;
      count(record, value.inputTypes, inputType(event.inputType));
      value.lastEditingContext = editingContext(editor);
      count(record, value.editingContexts, value.lastEditingContext);
    }
  }
  function copyRecord(record) {
    const value = record.diagnostics;
    return { ...record, diagnostics: { ...value, composition: { ...value.composition },
      composingEvents: { ...value.composingEvents }, inputTypes: { ...value.inputTypes },
      editingContexts: { ...value.editingContexts },
      targets: Object.fromEntries(Object.entries(value.targets).map(([key, counts]) => [key, { ...counts }])) } };
  }
  function observe(event) {
    if (stopped) return;
    timeline.observe(event, phase);
    if (!phase) return;
    const editor = document.querySelector('.cm-content[contenteditable="true"]');
    const container = document.querySelector(".cm-editor");
    const target = event.target, record = records[phase];
    const inEditor = !!editor && !!target && editor.contains(target);
    const inContainer = !!container && !!target && container.contains(target);
    const pointer = ["pointerdown", "mousedown", "click"].includes(event.type);
    if (!pointer && !inEditor) return;
    if (event.isTrusted !== true) { increment(record, "rejectedUntrusted"); return; }
    if (pointer) count(record, record.diagnostics.targets[event.type], inEditor ? "editor" : inContainer ? "container" : "outside");
    if (!inEditor) return;
    editingDiagnostics(event, record, editor);
    if (event.type === "pointerdown") increment(record, "trustedEditorPointers");
    else if (event.type === "keydown") increment(record, "trustedKeydowns");
    else if (event.type === "beforeinput") increment(record, "trustedBeforeInputs");
    else if (event.type === "input") increment(record, "trustedInputs");
  }
  const events = ["pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "compositionstart", "compositionend"];
  function stop() {
    if (stopped) return;
    stopped = true;
    timeline.stop();
    for (const type of events) document.removeEventListener(type, observe, true);
    window.removeEventListener("pagehide", stop);
    window.removeEventListener("atools-plugin-out", stop);
  }
  for (const type of events) document.addEventListener(type, observe, true);
  window.addEventListener("pagehide", stop);
  window.addEventListener("atools-plugin-out", stop);
  window.__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__ = {
    begin(value) {
      if (stopped || !phases.has(value) || records[value]) throw Error("NativePlainTextUiPhaseRejected");
      phase = value;
      records[value] = empty();
    },
    snapshot() {
      return { schemaVersion: 2, phase, stopped, listenerCount: stopped ? 0 : events.length,
        lifecycleListenerCount: stopped ? 0 : 2,
        timeline: timeline.snapshot(),
        records: Object.fromEntries(Object.entries(records).map(([key, value]) => [key, copyRecord(value)])) };
    },
    stop,
  };
})();
