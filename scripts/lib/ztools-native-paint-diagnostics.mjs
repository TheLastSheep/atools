const THEMES = Object.freeze(["light", "dark"]);
const POLICIES = new Set(["none", "suspend", "throttle", "unsupported"]);
const ROOT_KEYS = Object.freeze(["light", "dark"]);
const RECORD_KEYS = Object.freeze(["nativeSchedulingPolicy", "observations"]);
const OBSERVATION_KEYS = Object.freeze([
  "documentHidden", "before", "after", "rafCallbacks", "elapsedMs", "timedOut",
]);
const SIDEBAR_KEYS = Object.freeze([
  "generalUnique", "generalActive", "generalColorComparable", "generalColorUsesPrimary",
  "shortcutUnique", "shortcutInactive", "shortcutColorComparable", "shortcutColorUsesText",
]);
const MENU_KEYS = Object.freeze(["total", "body", "theme", "leave", "enter", "ownersOpen", "visible"]);
const SIDEBAR_SNAPSHOT_KEYS = Object.freeze(["sidebar", "menus"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function emptySummary(state) {
  return Object.fromEntries(THEMES.map(theme => [theme, { state }]));
}

function validateSidebarSnapshot(value, theme, phase, errors) {
  if (!exactKeys(value, SIDEBAR_SNAPSHOT_KEYS)) {
    errors.push(`paint-diagnostics-${theme}-${phase}-shape`);
    return;
  }

  if (!exactKeys(value.sidebar, SIDEBAR_KEYS)) {
    errors.push(`paint-diagnostics-${theme}-${phase}-sidebar-shape`);
  } else {
    for (const key of SIDEBAR_KEYS) {
      if (typeof value.sidebar[key] !== "boolean") {
        errors.push(`paint-diagnostics-${theme}-${phase}-sidebar-${key}`);
      }
    }
  }

  if (!exactKeys(value.menus, MENU_KEYS)) {
    errors.push(`paint-diagnostics-${theme}-${phase}-menus-shape`);
    return;
  }
  for (const key of MENU_KEYS) {
    const count = value.menus[key];
    if (!Number.isSafeInteger(count) || count < 0 || count > 64) {
      errors.push(`paint-diagnostics-${theme}-${phase}-menus-${key}`);
    }
  }
}

function validateRecord(value, theme, errors) {
  const start = errors.length;
  if (!exactKeys(value, RECORD_KEYS)) {
    errors.push(`paint-diagnostics-${theme}-record-shape`);
    return { state: "invalid" };
  }

  if (!POLICIES.has(value.nativeSchedulingPolicy)) {
    errors.push(`paint-diagnostics-${theme}-native-scheduling-policy`);
  }
  const observations = value.observations;
  if (!exactKeys(observations, OBSERVATION_KEYS)) {
    errors.push(`paint-diagnostics-${theme}-observations-shape`);
    return { state: "invalid" };
  }

  if (typeof observations.documentHidden !== "boolean") {
    errors.push(`paint-diagnostics-${theme}-document-hidden`);
  }
  validateSidebarSnapshot(observations.before, theme, "before", errors);
  validateSidebarSnapshot(observations.after, theme, "after", errors);
  if (!Number.isSafeInteger(observations.rafCallbacks)
      || observations.rafCallbacks < 0 || observations.rafCallbacks > 2) {
    errors.push(`paint-diagnostics-${theme}-raf-callbacks`);
  }
  if (typeof observations.elapsedMs !== "number" || !Number.isFinite(observations.elapsedMs)
      || observations.elapsedMs < 0 || observations.elapsedMs > 2000) {
    errors.push(`paint-diagnostics-${theme}-elapsed`);
  }
  if (typeof observations.timedOut !== "boolean") {
    errors.push(`paint-diagnostics-${theme}-timed-out`);
  }

  if (errors.length !== start) return { state: "invalid" };
  return {
    state: "observed",
    nativeSchedulingPolicy: value.nativeSchedulingPolicy,
    observations,
  };
}

/** Validates bounded Native paint diagnostics without treating them as visual acceptance. */
export function validateNativePaintDiagnostics(value) {
  const errors = [];
  if (!exactKeys(value, ROOT_KEYS)) {
    return {
      valid: false,
      errors: ["paint-diagnostics-shape"],
      summary: emptySummary("invalid"),
    };
  }

  const summary = {};
  for (const theme of THEMES) {
    if (value[theme] === null) {
      summary[theme] = { state: "unverified", reason: "diagnostics-unavailable" };
      continue;
    }
    const themeErrors = [];
    summary[theme] = validateRecord(value[theme], theme, themeErrors);
    errors.push(...themeErrors);
  }
  return { valid: errors.length === 0, errors, summary };
}
