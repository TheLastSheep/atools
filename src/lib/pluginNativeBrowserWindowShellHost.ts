import type { PluginFrameReplyTarget } from "./pluginFrameDocumentIdentity";

const GLOBAL_NAME = "__ATOOLS_NATIVE_WINDOWS__";
const SHELL_NAME = "__ATOOLS_NATIVE_SHELL__";
const SHELL_VERSION = 1;
const TICKET = /^[0-9a-f]{64}$/;
const SOURCE_BINDING = /^[0-9a-f]{64}$/;
const WINDOW_ID = /^plugin-browser-window-[a-z0-9-]{1,96}$/i;

type NativeShellApi = {
  bind: (request: { ticket: string; nonce: string; sourceBindingId: string; windowId: string; frame: HTMLIFrameElement }) => boolean;
  setLocation: (ticket: string, nonce: string, location: string) => boolean;
  postMessage: (ticket: string, nonce: string, message: unknown, targetOrigin: string, transfer?: Transferable[]) => void;
  dispose: (ticket: string, nonce: string) => void;
};
type NativeShellWindow = Window & { [SHELL_NAME]?: NativeShellApi };

type Route = {
  sourceBindingId: string;
  windowId: string;
  isCurrent: () => boolean;
  onChildMessage: (event: MessageEvent) => boolean;
  ticket?: string;
  nonce?: string;
  proxy?: NativeShellWindow;
  frame?: HTMLIFrameElement;
  disposed: boolean;
  shellPromise: Promise<NativeShellWindow>;
  resolveShell: (proxy: NativeShellWindow) => void;
  rejectShell: (error: Error) => void;
};

type GlobalApi = {
  version: number;
  openAuthorized: (sourceBindingId: string, windowId: string, url: string) => boolean;
  forwardChildMessage: (sourceBindingId: string, windowId: string, ticket: string, nonce: string, event: MessageEvent) => boolean;
};

function routeKey(sourceBindingId: string, windowId: string) {
  return JSON.stringify([sourceBindingId, windowId]);
}

type UrlTuple = Pick<URL, "protocol" | "hostname" | "port">;

function tuple(value: URL | Location): UrlTuple {
  return { protocol: value.protocol.toLowerCase(), hostname: value.hostname.toLowerCase(), port: value.port };
}

function sameTuple(left: UrlTuple, right: UrlTuple) {
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

function tupleOrigin(value: UrlTuple) {
  return `${value.protocol}//${value.hostname}${value.port ? `:${value.port}` : ""}`;
}

function allowedShellProtocol(protocol: string) {
  return protocol === "tauri:" || protocol === "http:" || protocol === "https:";
}

function validShellEventOrigin(expected: UrlTuple, actual: string) {
  const serialized = tupleOrigin(expected);
  return expected.protocol === "tauri:"
    ? actual === "null" || actual === serialized
    : actual === serialized;
}

function shellUrl(host: Window, value: string) {
  let parsed: URL;
  try { parsed = new URL(value, host.location.href); }
  catch { throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_URL"); }
  const expected = tuple(host.location), actual = tuple(parsed);
  if (!allowedShellProtocol(expected.protocol) || !expected.hostname || !sameTuple(actual, expected)
    || parsed.username || parsed.password || parsed.pathname !== "/atools-native-window.html"
    || parsed.search !== "" || !TICKET.test(parsed.hash.slice(1))) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_URL");
  return { href: parsed.href, ticket: parsed.hash.slice(1) };
}

/** Owns the trusted same-origin shell bridge; plugin content stays in an opaque iframe. */
export function createPluginNativeBrowserWindowShellHost(host: Window = window) {
  const routes = new Map<string, Route>();
  let installed: GlobalApi | undefined;
  function currentRoute(sourceBindingId: string, windowId: string) {
    return routes.get(routeKey(sourceBindingId, windowId));
  }
  function authorizeOpen(sourceBindingId: string, windowId: string, url: string) {
    const route = currentRoute(sourceBindingId, windowId);
    if (!route || route.disposed || !route.isCurrent() || route.proxy) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_ROUTE");
    const parsed = shellUrl(host, url);
    const opened = host.open(parsed.href, "_blank");
    if (!opened) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_OPEN_BLOCKED");
    route.ticket = parsed.ticket;
    route.proxy = opened as NativeShellWindow;
    return true;
  }
  function receiveShellHello(event: MessageEvent) {
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
    const data = event.data as Record<string, unknown>;
    if (data.__atools_native_window_shell__ !== "hello" || data.version !== SHELL_VERSION
      || typeof data.ticket !== "string" || !TICKET.test(data.ticket)) return;
    const route = [...routes.values()].find(candidate => candidate.proxy === event.source);
    const expected = tuple(host.location);
    if (!route || route.disposed || !route.isCurrent() || route.ticket !== data.ticket
      || !validShellEventOrigin(expected, event.origin)) return;
    let href = "";
    try { href = route.proxy!.location.href; } catch { return; }
    try {
      const actual = shellUrl(host, href);
      if (actual.ticket !== route.ticket) return;
      route.resolveShell(route.proxy!);
    } catch { /* An unrelated same-origin page is not a shell. */ }
  }
  const api: GlobalApi = {
    version: SHELL_VERSION,
    openAuthorized: authorizeOpen,
    forwardChildMessage(sourceBindingId, windowId, ticket, nonce, event) {
      const route = currentRoute(sourceBindingId, windowId);
      if (!route || route.disposed || !route.isCurrent() || route.ticket !== ticket || route.nonce !== nonce
        || !route.frame?.contentWindow || event.source !== route.frame.contentWindow) return false;
      return route.onChildMessage(event);
    },
  };
  function install() {
    const target = host as Window & { [GLOBAL_NAME]?: GlobalApi };
    if (target[GLOBAL_NAME] && target[GLOBAL_NAME] !== installed && target[GLOBAL_NAME]!.version !== SHELL_VERSION)
      throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_HOST_CONFLICT");
    if (!target[GLOBAL_NAME]) Object.defineProperty(target, GLOBAL_NAME, { configurable: true, value: api });
    installed = target[GLOBAL_NAME]!;
    if (installed !== api) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_HOST_CONFLICT");
    host.addEventListener("message", receiveShellHello);
  }
  function register(options: {
    sourceBindingId: string;
    windowId: string;
    isCurrent: () => boolean;
    onChildMessage: (event: MessageEvent) => boolean;
  }) {
    if (!SOURCE_BINDING.test(options.sourceBindingId) || !WINDOW_ID.test(options.windowId))
      throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_ROUTE");
    install();
    const key = routeKey(options.sourceBindingId, options.windowId);
    if (routes.has(key)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_DUPLICATE_ROUTE");
    let resolveShell!: (proxy: NativeShellWindow) => void, rejectShell!: (error: Error) => void;
    const shellPromise = new Promise<NativeShellWindow>((resolve, reject) => { resolveShell = resolve; rejectShell = reject; });
    void shellPromise.catch(() => undefined);
    const route: Route = { ...options, disposed: false, shellPromise, resolveShell, rejectShell };
    routes.set(key, route);
    function assertRoute() {
      if (route.disposed || routes.get(key) !== route || !route.isCurrent()) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_ROUTE_STALE");
    }
    return {
      openAuthorized: (url: string) => { assertRoute(); return authorizeOpen(options.sourceBindingId, options.windowId, url); },
      async waitForShell(timeoutMs = 5_000) {
        assertRoute();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const proxy = await Promise.race([shellPromise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_TIMEOUT")), timeoutMs);
          })]);
          assertRoute();
          const ticket = route.ticket, nonce = crypto.randomUUID().replace(/-/g, "");
          if (!ticket || !proxy.document || proxy.document.location.pathname !== "/atools-native-window.html")
            throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_IDENTITY");
          const frame = proxy.document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-scripts allow-popups");
          frame.setAttribute("title", "Plugin window content");
          Object.assign(frame.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0", margin: "0", padding: "0", background: "transparent" });
          proxy.document.body.replaceChildren(frame);
          const shell = proxy[SHELL_NAME];
          if (!shell || !shell.bind({ ticket, nonce, sourceBindingId: route.sourceBindingId,
            windowId: route.windowId, frame })) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_BIND");
          route.nonce = nonce;
          route.frame = frame;
          return {
            frame,
            replyTarget: {
              postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]) {
                assertRoute();
                shell.postMessage(ticket, nonce, message, targetOrigin, transfer);
              },
            } satisfies PluginFrameReplyTarget,
            setLocation(location: string) {
              assertRoute();
              if (!shell.setLocation(ticket, nonce, location)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_DOCUMENT");
            },
          };
        } finally { if (timer !== undefined) clearTimeout(timer); }
      },
      dispose() {
        if (route.disposed) return;
        route.disposed = true;
        routes.delete(key);
        route.rejectShell(Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_ROUTE_CLOSED"));
        try { if (route.ticket && route.nonce) route.proxy?.[SHELL_NAME]?.dispose(route.ticket, route.nonce); } catch { /* window already destroyed */ }
        route.frame = undefined;
        route.proxy = undefined;
        if (routes.size === 0 && installed === api) {
          host.removeEventListener("message", receiveShellHello);
          const target = host as Window & { [GLOBAL_NAME]?: GlobalApi };
          delete target[GLOBAL_NAME];
          installed = undefined;
        }
      },
    };
  }
  return { register, dispose: () => { for (const route of [...routes.values()]) {
    route.disposed = true; route.rejectShell(Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_ROUTE_CLOSED"));
    try { if (route.ticket && route.nonce) route.proxy?.[SHELL_NAME]?.dispose(route.ticket, route.nonce); } catch { /* window already destroyed */ }
  } routes.clear(); host.removeEventListener("message", receiveShellHello);
    const target = host as Window & { [GLOBAL_NAME]?: GlobalApi }; if (target[GLOBAL_NAME] === api) delete target[GLOBAL_NAME]; installed = undefined;
  } };
}
