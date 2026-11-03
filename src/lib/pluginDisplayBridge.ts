export type PluginDisplayConfig = { instanceId: string; sessionId?: string; endpoint?: string };
export type DisplayPoint = { x: number; y: number };
export type DisplayRect = DisplayPoint & { width: number; height: number };
export type PluginNativeDisplay = {
  id: number; bounds: DisplayRect; workArea: DisplayRect; size: { width: number; height: number };
  workAreaSize: { width: number; height: number }; scaleFactor: number; rotation: number; internal: boolean; label?: string;
};
export type PluginDisplaySnapshot = { schemaVersion: 1; platform: "darwin"; primaryId: number; cursor: DisplayPoint; displays: PluginNativeDisplay[] };
type Transport = (endpoint: string, payload: { operation: "snapshot" }) => unknown;

/** Self-contained: production serializes this factory before the original preload. */
export function createPluginDisplayBridge(config: PluginDisplayConfig, requestPermission: () => void, transport?: Transport) {
  let endpoint = config.endpoint, requested = false, closed = false;
  function failure(code: string, message: string) { return Object.assign(new Error(code + ": " + message), { code }); }
  const invalid = () => failure("ERR_ATOOLS_DISPLAY_RESPONSE", "Invalid native display snapshot");
  if (endpoint !== undefined && (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/display\/[0-9a-f]{64}$/.test(endpoint) || Number(endpoint.split(":")[2].split("/")[0]) > 65535)) {
    throw failure("ERR_ATOOLS_DISPLAY_CONFIG", "Invalid display endpoint");
  }
  function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || ![...required, ...optional].includes(key))
      || required.some(key => !Object.hasOwn(descriptors, key))) throw invalid();
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(descriptors)) {
      const property = descriptors[key];
      if (!Object.hasOwn(property, "value")) throw invalid();
      output[key] = property.value;
    }
    return output;
  }
  function finite(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e9) throw invalid();
    return value;
  }
  function point(value: unknown): DisplayPoint {
    const item = object(value, ["x", "y"]); return { x: finite(item.x), y: finite(item.y) };
  }
  function size(value: unknown, allowZero = false) {
    const item = object(value, ["width", "height"]), width = finite(item.width), height = finite(item.height);
    if (width < 0 || height < 0 || (!allowZero && (!width || !height))) throw invalid();
    return { width, height };
  }
  function rect(value: unknown, allowZero = false): DisplayRect {
    const item = object(value, ["x", "y", "width", "height"]);
    return { ...point({ x: item.x, y: item.y }), ...size({ width: item.width, height: item.height }, allowZero) };
  }
  function identifier(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid(); return Number(value);
  }
  function snapshotShape(value: unknown): PluginDisplaySnapshot {
    const item = object(value, ["schemaVersion", "platform", "primaryId", "cursor", "displays"]);
    if (item.schemaVersion !== 1 || item.platform !== "darwin" || !Array.isArray(item.displays)
      || !item.displays.length || item.displays.length > 32) throw invalid();
    const nativeDisplays = item.displays;
    if (Object.getPrototypeOf(nativeDisplays) !== Array.prototype
      || Reflect.ownKeys(nativeDisplays).some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= nativeDisplays.length))) throw invalid();
    const displays: PluginNativeDisplay[] = [], ids = new Set<number>();
    for (let i = 0; i < nativeDisplays.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(nativeDisplays, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw invalid();
      const display = object(descriptor.value, ["id", "bounds", "workArea", "size", "workAreaSize", "scaleFactor", "rotation", "internal"], ["label"]);
      const id = identifier(display.id), bounds = rect(display.bounds), workArea = rect(display.workArea);
      const dimensions = size(display.size), workDimensions = size(display.workAreaSize), scaleFactor = finite(display.scaleFactor), rotation = finite(display.rotation);
      if (ids.has(id) || scaleFactor <= 0 || scaleFactor > 64 || rotation < 0 || rotation >= 360 || typeof display.internal !== "boolean"
        || dimensions.width !== bounds.width || dimensions.height !== bounds.height
        || workDimensions.width !== workArea.width || workDimensions.height !== workArea.height) throw invalid();
      const result: PluginNativeDisplay = { id, bounds, workArea, size: dimensions, workAreaSize: workDimensions, scaleFactor, rotation, internal: display.internal };
      if (Object.hasOwn(display, "label")) {
        if (typeof display.label !== "string" || new TextEncoder().encode(display.label).length > 1024 || display.label.includes("\0")) throw invalid();
        result.label = display.label;
      }
      ids.add(id); displays.push(result);
    }
    const primaryId = identifier(item.primaryId);
    if (!ids.has(primaryId)) throw invalid();
    const result: PluginDisplaySnapshot = { schemaVersion: 1, platform: "darwin", primaryId, cursor: point(item.cursor), displays };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 64 * 1024) throw failure("ERR_ATOOLS_DISPLAY_LIMIT", "Display snapshot exceeds 64 KiB");
    return result;
  }
  function xhr(address: string, payload: { operation: "snapshot" }) {
    const request = new XMLHttpRequest(); request.open("POST", address, false);
    request.setRequestHeader("Content-Type", "application/json"); request.send(JSON.stringify(payload));
    if (request.status !== 200) throw failure("ERR_ATOOLS_DISPLAY_SESSION", "显示器会话已关闭，请重新打开插件");
    if (new TextEncoder().encode(request.responseText).length > 64 * 1024) throw failure("ERR_ATOOLS_DISPLAY_LIMIT", "Display response exceeds 64 KiB");
    let raw: unknown;
    try { raw = JSON.parse(request.responseText); } catch { throw invalid(); }
    const response = object(raw, ["ok"], ["result", "error"]);
    if (response.ok !== true || !Object.hasOwn(response, "result")) throw failure("ERR_ATOOLS_DISPLAY_REJECTED", "Native display operation rejected");
    return response.result;
  }
  function snapshot() {
    if (closed) throw failure("ERR_ATOOLS_DISPLAY_CLOSED", "显示器会话已关闭");
    if (!endpoint) {
      if (!requested) { requested = true; requestPermission(); }
      throw failure("ERR_ATOOLS_DISPLAY_PERMISSION_REQUIRED", "请允许读取显示器信息，然后重新打开插件");
    }
    return snapshotShape((transport ?? xhr)(endpoint, { operation: "snapshot" }));
  }
  function immutable<T>(value: T): T {
    if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
    return value;
  }
  function nearest(displays: PluginNativeDisplay[], cursor: DisplayPoint) {
    const contained = displays.filter(display => cursor.x >= display.bounds.x && cursor.y >= display.bounds.y
      && cursor.x < display.bounds.x + display.bounds.width && cursor.y < display.bounds.y + display.bounds.height);
    if (contained.length) return contained.reduce((a, b) => a.id <= b.id ? a : b);
    function distance(display: PluginNativeDisplay) {
      const bounds = display.bounds, dx = Math.max(bounds.x - cursor.x, 0, cursor.x - (bounds.x + bounds.width));
      const dy = Math.max(bounds.y - cursor.y, 0, cursor.y - (bounds.y + bounds.height)); return dx * dx + dy * dy;
    }
    // Native enumeration order can change: equal geometric distances always choose the lowest display ID.
    return displays.reduce((a, b) => distance(a) < distance(b) || (distance(a) === distance(b) && a.id < b.id) ? a : b);
  }
  function unsupported() { throw failure("ERR_ATOOLS_DISPLAY_UNSUPPORTED", "此坐标转换在 macOS 上不可用"); }
  return {
    getPrimaryDisplay() { const result = snapshot(); return immutable(result.displays.find(display => display.id === result.primaryId)!); },
    getAllDisplays() { return immutable(snapshot().displays); },
    getCursorScreenPoint() { return immutable(snapshot().cursor); },
    getDisplayNearestPoint(value: unknown) { const cursor = point(value); return immutable(nearest(snapshot().displays, cursor)); },
    getDisplayMatching(value: unknown) {
      const target = rect(value, true), displays = snapshot().displays;
      const intersections = displays.map(display => ({ display, area: Math.max(0, Math.min(target.x + target.width, display.bounds.x + display.bounds.width) - Math.max(target.x, display.bounds.x))
        * Math.max(0, Math.min(target.y + target.height, display.bounds.y + display.bounds.height) - Math.max(target.y, display.bounds.y)) }));
      const best = intersections.reduce((a, b) => a.area > b.area || (a.area === b.area && a.display.id < b.display.id) ? a : b);
      return immutable(best.area > 0 ? best.display : nearest(displays, { x: target.x + target.width / 2, y: target.y + target.height / 2 }));
    },
    dipToScreenRect(window: unknown, value?: unknown) {
      // ZTools' macOS implementation is identity; never multiply mixed-scale desktop coordinates by window.devicePixelRatio.
      if (value === undefined) return immutable(rect(window, true));
      if (window !== null && window !== undefined) throw failure("ERR_ATOOLS_DISPLAY_UNSUPPORTED", "BaseWindow coordinate conversion is unavailable");
      return immutable(rect(value, true));
    },
    screenToDipPoint: unsupported, dipToScreenPoint: unsupported, screenToDipRect: unsupported,
    close() { closed = true; endpoint = undefined; },
  };
}

export function pluginDisplayBridgeScript(config: PluginDisplayConfig): string {
  const safe = JSON.stringify({ instanceId: config.instanceId, endpoint: config.endpoint }).replace(/</g, "\\u003c");
  return '<script data-atools-native-display>(function(){var config=' + safe + ';var bridge=(' + createPluginDisplayBridge.toString() + ')(config,function(){var message={__atools_plugin_display_open__:true,instanceId:config.instanceId};if(window.__ATOOLS_FRAME_TRANSPORT__)window.__ATOOLS_FRAME_TRANSPORT__.post(message);else window.parent.postMessage(message,"*");});' +
    'window.__atoolsNativeDisplay=bridge;[window.utools,window.ztools].forEach(function(api){if(!api)return;["getPrimaryDisplay","getAllDisplays","getCursorScreenPoint","getDisplayNearestPoint","getDisplayMatching","dipToScreenRect","screenToDipPoint","dipToScreenPoint","screenToDipRect"].forEach(function(name){api[name]=bridge[name];});});' +
    'window.addEventListener("atools-plugin-out",function(){bridge.close();});window.addEventListener("pagehide",function(){bridge.close();});})();<\/script>';
}
