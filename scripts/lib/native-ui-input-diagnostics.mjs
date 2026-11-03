/** Fixed-size, text-free observations from the explicitly selected native editor fixture. */
export function emptyNativeUiInputDiagnostics() {
  return { schemaVersion: 2, composition: { starts: 0, ends: 0, active: false },
    composingEvents: { yes: 0, no: 0, unknown: 0 }, lastEditingIsComposing: "unknown",
    editingContexts: { visibleFocusedEditor: 0, visibleUnfocusedEditor: 0, visibleOtherFocus: 0, hidden: 0, unknown: 0 },
    lastEditingContext: "unknown",
    inputTypes: { insertText: 0, insertCompositionText: 0, insertFromComposition: 0, insertLineBreak: 0,
      insertParagraph: 0, deletion: 0, history: 0, other: 0, missing: 0 },
    targets: { pointerdown: { editor: 0, container: 0, outside: 0 },
      mousedown: { editor: 0, container: 0, outside: 0 }, click: { editor: 0, container: 0, outside: 0 } } };
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keysEqual = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const safe = value => Number.isSafeInteger(value) && value >= 0 && value <= 8192;
const counters = (value, keys) => keysEqual(value, keys) && keys.every(key => safe(value[key]));

export function nativeUiInputDiagnosticsValid(value, record) {
  const shape = emptyNativeUiInputDiagnostics();
  if (!keysEqual(value, Object.keys(shape)) || value.schemaVersion !== 2
    || !keysEqual(value.composition, ["starts", "ends", "active"])
    || !safe(value.composition.starts) || !safe(value.composition.ends) || typeof value.composition.active !== "boolean"
    || !counters(value.composingEvents, Object.keys(shape.composingEvents))
    || !["yes", "no", "unknown"].includes(value.lastEditingIsComposing)
    || !counters(value.editingContexts, Object.keys(shape.editingContexts))
    || !Object.hasOwn(shape.editingContexts, value.lastEditingContext)
    || !counters(value.inputTypes, Object.keys(shape.inputTypes))
    || !keysEqual(value.targets, Object.keys(shape.targets))
    || !Object.keys(shape.targets).every(type => counters(value.targets[type], ["editor", "container", "outside"]))) return false;
  // Every observed beforeinput/input has one composing and one input-type classification.
  const edits = record?.trustedBeforeInputs + record?.trustedInputs;
  return Number.isSafeInteger(edits) && edits >= 0
    && Object.values(value.composingEvents).reduce((sum, count) => sum + count, 0) === edits
    && Object.values(value.editingContexts).reduce((sum, count) => sum + count, 0) === edits
    && Object.values(value.inputTypes).reduce((sum, count) => sum + count, 0) === edits;
}

/** Composition observations supplement exact rendered-text and worker assertions; they never prove input alone. */
export function nativeUiInputCompositionSettled(value) {
  return value?.composition?.active === false && value.lastEditingIsComposing === "no";
}
