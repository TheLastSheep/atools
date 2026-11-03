import type {
  PluginBrowserWindowBounds,
  PluginBrowserWindowPoint,
  PluginBrowserWindowSize,
  PluginBrowserWindowState,
} from "./pluginBrowserWindowTypes";

export const PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS: PluginBrowserWindowBounds = { x: 0, y: 0, width: 560, height: 220 };
export const PLUGIN_BROWSER_WINDOW_MIN_WIDTH = 260;
export const PLUGIN_BROWSER_WINDOW_MIN_HEIGHT = 160;
export const PLUGIN_BROWSER_WINDOW_MAX_WIDTH = 1200;
export const PLUGIN_BROWSER_WINDOW_MAX_HEIGHT = 900;
export const PLUGIN_BROWSER_WINDOW_MAX_POSITION = 2000;

export function browserWindowOptions(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function browserWindowTitle(url: string, options: Record<string, unknown>): string {
  return typeof options.title === "string" && options.title.trim()
    ? options.title.trim().slice(0, 80)
    : url;
}

export function browserWindowCapabilityFlag(options: Record<string, unknown>, key: string): boolean {
  return options[key] !== false;
}

export function browserWindowFullScreenFlag(options: Record<string, unknown>): boolean {
  return options.fullScreen === true || options.fullscreen === true;
}

export function browserWindowFullScreenableFlag(options: Record<string, unknown>): boolean {
  return options.fullScreenable !== false && options.fullscreenable !== false;
}

export function browserWindowOpacity(value: unknown): number {
  const opacity = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(opacity)) return 1;
  return Math.min(1, Math.max(0, opacity));
}

export function browserWindowProgressMode(value: unknown, fallback = "normal"): string {
  const mode = typeof value === "string" ? value.trim() : "";
  return ["none", "normal", "indeterminate", "error", "paused"].includes(mode) ? mode : fallback;
}

export function browserWindowProgressState(progressValue: unknown, optionsValue: unknown): { progressBar: number | null; progressBarMode: string } {
  const progress = typeof progressValue === "number" ? progressValue : Number(progressValue);
  const options = optionsValue && typeof optionsValue === "object" ? optionsValue as Record<string, unknown> : {};
  if (!Number.isFinite(progress) || progress < 0) return { progressBar: null, progressBarMode: "none" };
  if (progress > 1) return { progressBar: null, progressBarMode: "indeterminate" };
  return {
    progressBar: Math.min(1, Math.max(0, progress)),
    progressBarMode: browserWindowProgressMode(options.mode),
  };
}

export function pluginBrowserWindowZoomLevelFromFactor(factor: number): number {
  return Math.log(factor) / Math.log(1.2);
}

export function pluginBrowserWindowZoomFactorFromLevel(level: number): number {
  return Math.pow(1.2, level);
}

export function normalizePluginBrowserWindowZoomFactor(value: unknown): number {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("webContents.setZoomFactor requires a factor greater than 0");
  }
  return factor;
}

export function normalizePluginBrowserWindowZoomLevel(value: unknown, label: string): number {
  const level = Number(value);
  if (!Number.isFinite(level)) {
    throw new Error(`${label} requires a finite zoom level`);
  }
  return level;
}

export function pluginBrowserWindowZoomResult(childWindow: PluginBrowserWindowState) {
  return {
    zoomFactor: childWindow.zoomFactor,
    zoomLevel: childWindow.zoomLevel,
    minimumLevel: childWindow.visualZoomMinimumLevel,
    maximumLevel: childWindow.visualZoomMaximumLevel,
  };
}

export function browserWindowInitialUserAgent(options: Record<string, unknown>): string {
  const webPreferences = options.webPreferences && typeof options.webPreferences === "object"
    ? options.webPreferences as Record<string, unknown>
    : {};
  const configured = typeof options.userAgent === "string"
    ? options.userAgent
    : typeof webPreferences.userAgent === "string"
      ? webPreferences.userAgent
      : "";
  return configured || (typeof navigator !== "undefined" ? navigator.userAgent : "");
}

export function browserWindowProcessId(windowSeq: number): number {
  return Math.max(1, Math.round(windowSeq));
}

export function browserWindowOSProcessId(windowSeq: number): number {
  return 100000 + browserWindowProcessId(windowSeq);
}

export function normalizePluginBrowserWindowFrameRate(value: unknown): number {
  const frameRate = Number(value);
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error("webContents.setFrameRate requires a positive frame rate");
  }
  return Math.min(240, Math.max(1, Math.round(frameRate)));
}

export function pluginBrowserWindowRuntimeResult(childWindow: PluginBrowserWindowState) {
  return {
    userAgent: childWindow.userAgent,
    frameRate: childWindow.frameRate,
    backgroundThrottling: childWindow.backgroundThrottling,
    processId: childWindow.processId,
    osProcessId: childWindow.osProcessId,
  };
}


export function browserWindowNumber(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : fallback;
}

export function browserWindowDimension(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, browserWindowNumber(value, fallback)));
}

export function browserWindowHexPair(value: unknown): string {
  const numeric = Math.min(255, Math.max(0, Math.round(Number(value) || 0)));
  return numeric.toString(16).padStart(2, "0");
}

export function normalizePluginBrowserWindowBackgroundColor(value: unknown, fallback = "#ffffff"): string {
  const raw = String(value ?? "").trim();
  const fallbackColor = /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : "#ffffff";
  const hex = raw.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hex) {
    const body = hex[1];
    if (body.length === 3) return `#${body.split("").map((ch) => ch + ch).join("")}`.toLowerCase();
    if (body.length === 4) return `#${body.slice(1).split("").map((ch) => ch + ch).join("")}`.toLowerCase();
    if (body.length === 8) return `#${body.slice(2)}`.toLowerCase();
    return `#${body}`.toLowerCase();
  }
  const rgb = raw.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
  if (rgb) return `#${browserWindowHexPair(rgb[1])}${browserWindowHexPair(rgb[2])}${browserWindowHexPair(rgb[3])}`;
  const namedColors: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    blueviolet: "#8a2be2",
  };
  return namedColors[raw] || fallbackColor;
}

export function browserWindowPosition(value: unknown, fallback: number): number {
  return Math.min(PLUGIN_BROWSER_WINDOW_MAX_POSITION, Math.max(0, browserWindowNumber(value, fallback)));
}

export function browserWindowOptionNumber(options: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(options, key)) return browserWindowNumber(options[key], fallback);
  }
  return fallback;
}

export function normalizePluginBrowserWindowSize(
  value: unknown,
  fallback: PluginBrowserWindowSize = {
    width: PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS.width,
    height: PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS.height,
  },
  constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
): PluginBrowserWindowSize {
  const source = Array.isArray(value) ? value : [];
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return constrainPluginBrowserWindowSize(
    {
      width: browserWindowNumber(source[0] ?? record.width, fallback.width),
      height: browserWindowNumber(source[1] ?? record.height, fallback.height),
    },
    constraints,
  );
}

export function constrainPluginBrowserWindowSize(
  size: PluginBrowserWindowSize,
  constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
): PluginBrowserWindowSize {
  const minimumWidth = constraints?.minimumWidth ?? PLUGIN_BROWSER_WINDOW_MIN_WIDTH;
  const minimumHeight = constraints?.minimumHeight ?? PLUGIN_BROWSER_WINDOW_MIN_HEIGHT;
  const maximumWidth = Math.max(minimumWidth, constraints?.maximumWidth ?? PLUGIN_BROWSER_WINDOW_MAX_WIDTH);
  const maximumHeight = Math.max(minimumHeight, constraints?.maximumHeight ?? PLUGIN_BROWSER_WINDOW_MAX_HEIGHT);
  return {
    width: Math.min(maximumWidth, Math.max(minimumWidth, size.width)),
    height: Math.min(maximumHeight, Math.max(minimumHeight, size.height)),
  };
}

export function initialPluginBrowserWindowSizeConstraints(options: Record<string, unknown>) {
  const minimumWidth = browserWindowDimension(
    browserWindowOptionNumber(options, ["minWidth", "minimumWidth", "minwidth", "minimumwidth", "min-width"], PLUGIN_BROWSER_WINDOW_MIN_WIDTH),
    PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
    PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
    PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
  );
  const minimumHeight = browserWindowDimension(
    browserWindowOptionNumber(options, ["minHeight", "minimumHeight", "minheight", "minimumheight", "min-height"], PLUGIN_BROWSER_WINDOW_MIN_HEIGHT),
    PLUGIN_BROWSER_WINDOW_MIN_HEIGHT,
    PLUGIN_BROWSER_WINDOW_MIN_HEIGHT,
    PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
  );
  const maximumWidth = browserWindowDimension(
    browserWindowOptionNumber(options, ["maxWidth", "maximumWidth", "maxwidth", "maximumwidth", "max-width"], PLUGIN_BROWSER_WINDOW_MAX_WIDTH),
    PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
    minimumWidth,
    PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
  );
  const maximumHeight = browserWindowDimension(
    browserWindowOptionNumber(options, ["maxHeight", "maximumHeight", "maxheight", "maximumheight", "max-height"], PLUGIN_BROWSER_WINDOW_MAX_HEIGHT),
    PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
    minimumHeight,
    PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
  );
  return { minimumWidth, minimumHeight, maximumWidth, maximumHeight };
}

export function pluginBrowserWindowAspectRatioExtraSize(value: unknown): PluginBrowserWindowSize {
  return normalizePluginBrowserWindowSize(value, { width: 0, height: 0 }, {
    minimumWidth: 0,
    minimumHeight: 0,
    maximumWidth: PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
    maximumHeight: PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
  });
}

export function pluginBrowserWindowNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function pluginBrowserWindowPlainOptions(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizePluginBrowserWindowPoint(value: unknown): PluginBrowserWindowPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    x: pluginBrowserWindowNumber(record.x, 0),
    y: pluginBrowserWindowNumber(record.y, 0),
  };
}

export function pluginBrowserWindowNullableString(value: unknown) {
  if (value == null) return "";
  const raw = String(value);
  return raw.length > 0 ? raw : "";
}

export function normalizePluginBrowserWindowBounds(
  value: unknown,
  fallback: PluginBrowserWindowBounds = PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS,
  constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
): PluginBrowserWindowBounds {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const size = normalizePluginBrowserWindowSize(record, fallback, constraints);
  return {
    x: browserWindowPosition(record.x, fallback.x),
    y: browserWindowPosition(record.y, fallback.y),
    ...size,
  };
}

export function initialPluginBrowserWindowBounds(
  options: Record<string, unknown>,
  constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
): PluginBrowserWindowBounds & { positioned: boolean } {
  const bounds = normalizePluginBrowserWindowBounds(options, PLUGIN_BROWSER_WINDOW_DEFAULT_BOUNDS, constraints);
  return {
    ...bounds,
    positioned: Object.prototype.hasOwnProperty.call(options, "x") || Object.prototype.hasOwnProperty.call(options, "y"),
  };
}

export function pluginBrowserWindowBounds(childWindow: PluginBrowserWindowState): PluginBrowserWindowBounds {
  return {
    x: childWindow.x,
    y: childWindow.y,
    width: childWindow.width,
    height: childWindow.height,
  };
}

export function pluginBrowserWindowLayer(childWindow: PluginBrowserWindowState): string {
  const base = childWindow.alwaysOnTop ? 3000 : childWindow.focused ? 2000 : 1000;
  return ` z-index: ${base + childWindow.zOrder};`;
}

export function pluginBrowserWindowStyle(childWindow: PluginBrowserWindowState): string {
  const appearance = childWindow.opacity < 1 ? ` opacity: ${childWindow.opacity};` : "";
  const background = ` background: ${childWindow.backgroundColor};`;
  if (childWindow.kiosk || childWindow.fullScreen || childWindow.maximized) {
    const layer = pluginBrowserWindowLayer(childWindow);
    return `width: 100%; height: 100%; left: 0; top: 0;${layer}${appearance}${background}`;
  }
  const size = `width: ${childWindow.width}px; height: ${childWindow.height}px;`;
  if (childWindow.minimized) {
    const layer = pluginBrowserWindowLayer(childWindow);
    const position = childWindow.positioned ? ` left: ${childWindow.x}px; top: ${childWindow.y}px;` : "";
    return `width: ${childWindow.width}px; height: 42px;${position}${layer}${appearance}${background}`;
  }
  const layer = pluginBrowserWindowLayer(childWindow);
  if (!childWindow.positioned) return `${size}${layer}${appearance}${background}`;
  return `${size} left: ${childWindow.x}px; top: ${childWindow.y}px;${layer}${appearance}${background}`;
}

export function pluginBrowserWindowFrameStyle(childWindow: PluginBrowserWindowState): string {
  const factor = Number.isFinite(childWindow.zoomFactor) && childWindow.zoomFactor > 0
    ? childWindow.zoomFactor
    : 1;
  if (Math.abs(factor - 1) < 0.0001) return "";
  return `transform: scale(${factor}); transform-origin: 0 0; width: ${100 / factor}%; height: ${100 / factor}%;`;
}

export function browserWindowActionArgs(args: Record<string, unknown>): unknown[] {
  return Array.isArray(args.args) ? args.args : [];
}

export function browserWindowSizeFromArgs(
  actionArgs: unknown[],
  fallback: PluginBrowserWindowSize,
  constraints?: Pick<PluginBrowserWindowState, "minimumWidth" | "minimumHeight" | "maximumWidth" | "maximumHeight">,
): PluginBrowserWindowSize {
  const source = Array.isArray(actionArgs[0]) ? actionArgs[0] : actionArgs;
  return normalizePluginBrowserWindowSize(source, fallback, constraints);
}

export function browserWindowPositionFromArgs(actionArgs: unknown[], fallback: PluginBrowserWindowBounds): Pick<PluginBrowserWindowBounds, "x" | "y"> {
  const source = Array.isArray(actionArgs[0]) ? actionArgs[0] : actionArgs;
  return {
    x: browserWindowPosition(source[0], fallback.x),
    y: browserWindowPosition(source[1], fallback.y),
  };
}


