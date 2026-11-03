/** Navigation names handled against ATools' child-document lifecycle rather than native RPC. */
export const NATIVE_BROWSER_WINDOW_NAVIGATION_ACTIONS = new Set([
  "webContents.loadURL", "webContents.reload", "webContents.reloadIgnoringCache",
  "webContents.goBack", "webContents.goForward", "webContents.navigationHistory.goBack",
  "webContents.navigationHistory.goForward", "webContents.navigationHistory.goToIndex",
  "webContents.navigationHistory.goToOffset", "webContents.navigationHistory.clear", "webContents.stop",
]);

const publicActionAliases = new Map<string, string>([
  ["loadURL", "webContents.loadURL"],
  ["reload", "webContents.reload"],
]);

/** Keep BrowserWindow's public method names on the same audited navigation path as webContents. */
export function normalizeNativeBrowserWindowActionName(name: string): string {
  return publicActionAliases.get(name) ?? name;
}

export type NativeBrowserWindowNavigationActionResult = { handled: false } | { handled: true; value: unknown };

/** Execute the navigation aliases after the controller has authenticated the source and owner. */
export async function runNativeBrowserWindowNavigationAction(args: {
  windowId: string;
  action: string;
  actionArgs: unknown[];
  currentUrl: (windowId: string) => string | undefined;
  navigate: (url: string, reloaded: boolean, ignoreCache: boolean) => Promise<unknown>;
  navigateHistory: (actionName: string, actionArgs: unknown[]) => Promise<unknown>;
  clearHistory: () => unknown;
  failure: (code: string) => Error;
}): Promise<NativeBrowserWindowNavigationActionResult> {
  const name = normalizeNativeBrowserWindowActionName(args.action);
  if (name === "getURL") {
    const url = args.currentUrl(args.windowId);
    if (url === undefined) throw args.failure("WINDOW_CLOSED");
    return { handled: true, value: url };
  }
  if (!NATIVE_BROWSER_WINDOW_NAVIGATION_ACTIONS.has(name)) return { handled: false };
  if (name === "webContents.navigationHistory.clear")
    return { handled: true, value: args.clearHistory() };
  if (name === "webContents.stop") throw args.failure("UNSUPPORTED_ACTION");
  if (name === "webContents.loadURL")
    return { handled: true, value: await args.navigate(String(args.actionArgs[0] ?? ""), false, false) };
  if (name === "webContents.reload" || name === "webContents.reloadIgnoringCache") {
    const url = args.currentUrl(args.windowId);
    if (url === undefined) throw args.failure("WINDOW_CLOSED");
    return { handled: true, value: await args.navigate(url, true, name === "webContents.reloadIgnoringCache") };
  }
  return { handled: true, value: await args.navigateHistory(name, args.actionArgs) };
}
