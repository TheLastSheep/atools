const OPTIONS = new Set([
  "title", "x", "y", "width", "height", "minWidth", "minimumWidth", "minwidth", "minimumwidth",
  "minHeight", "minimumHeight", "minheight", "minimumheight", "maxWidth", "maximumWidth", "maxwidth", "maximumwidth",
  "maxHeight", "maximumHeight", "maxheight", "maximumheight", "center", "frame", "transparent", "alwaysOnTop", "alwaysontop",
  "show", "focusable", "resizable", "closable", "minimizable", "maximizable", "fullScreen", "fullscreen", "fullscreenable",
  "fullScreenable", "skipTaskbar", "skiptaskbar", "visibleOnAllWorkspaces", "visibleonallworkspaces", "hasShadow", "hasshadow",
  "ignoreMouseEvents", "ignoremouseevents", "useContentSize", "backgroundColor", "backgroundcolor", "webPreferences",
]);
const BOOLS = ["center", "frame", "transparent", "alwaysOnTop", "alwaysontop", "show", "focusable", "resizable", "closable",
  "minimizable", "maximizable", "fullScreen", "fullscreen", "fullscreenable", "fullScreenable", "skipTaskbar", "skiptaskbar",
  "visibleOnAllWorkspaces", "visibleonallworkspaces", "hasShadow", "hasshadow", "ignoreMouseEvents", "ignoremouseevents", "useContentSize"];
const WEB_PREFERENCES = new Set(["preload", "backgroundThrottling", "nodeIntegration", "contextIsolation"]);

function invalid(reason: string): never {
  throw Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_OPTIONS:${reason}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("expected an options object");
  return value as Record<string, unknown>;
}

function assertAliases(options: Record<string, unknown>, aliases: string[]) {
  const supplied = aliases.filter(key => Object.hasOwn(options, key));
  if (supplied.length > 1 && supplied.some(key => options[key] !== options[supplied[0]]))
    invalid(`conflicting aliases: ${supplied.join(", ")}`);
}

/** Keep renderer settings in the preload pipeline and send only the explicit native WindowSpec contract to Rust. */
export function nativePluginBrowserWindowOptions(value: unknown) {
  const input = record(value);
  for (const key of Object.keys(input)) if (!OPTIONS.has(key)) invalid(`unsupported option ${key}`);
  const preferences = input.webPreferences;
  if (preferences !== undefined) {
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) invalid("webPreferences must be an object");
    const fields = preferences as Record<string, unknown>;
    if (Object.keys(fields).some(key => !WEB_PREFERENCES.has(key))) invalid("unsupported webPreferences field");
    if (Object.hasOwn(fields, "backgroundThrottling") && typeof fields.backgroundThrottling !== "boolean")
      invalid("webPreferences.backgroundThrottling must be boolean");
    for (const key of ["nodeIntegration", "contextIsolation"]) {
      if (Object.hasOwn(fields, key) && fields[key] !== false) invalid(`webPreferences.${key} must be false`);
    }
  }
  for (const key of BOOLS) if (Object.hasOwn(input, key) && typeof input[key] !== "boolean") invalid(`${key} must be boolean`);
  for (const aliases of [["alwaysOnTop", "alwaysontop"], ["fullScreen", "fullscreen"], ["fullscreenable", "fullScreenable"],
    ["skipTaskbar", "skiptaskbar"], ["visibleOnAllWorkspaces", "visibleonallworkspaces"], ["hasShadow", "hasshadow"],
    ["ignoreMouseEvents", "ignoremouseevents"], ["backgroundColor", "backgroundcolor"]]) assertAliases(input, aliases);
  const native: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) if (key !== "webPreferences" && key !== "backgroundcolor") native[key] = item;
  if (Object.hasOwn(input, "backgroundcolor")) native.backgroundColor = input.backgroundcolor;
  if (preferences && typeof preferences === "object" && !Array.isArray(preferences)
    && Object.hasOwn(preferences, "backgroundThrottling")) {
    native.backgroundThrottling = (preferences as Record<string, unknown>).backgroundThrottling;
  }
  if (Object.hasOwn(native, "backgroundColor")) {
    if (typeof native.backgroundColor !== "string" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(native.backgroundColor))
      invalid("backgroundColor must be #RRGGBB or #RRGGBBAA");
    native.backgroundColor = (native.backgroundColor as string).toLowerCase();
  }
  return { nativeOptions: native, preloadOptions: input };
}
