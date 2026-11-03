import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createPluginNativeBrowserWindowShellHost } from "../../src/lib/pluginNativeBrowserWindowShellHost";

const HOST_NAME = "__ATOOLS_NATIVE_WINDOWS__";
const SHELL_NAME = "__ATOOLS_NATIVE_SHELL__";
const TICKET = "a".repeat(64);
const SOURCE_BINDING = "b".repeat(64);
const WINDOW_ID = "plugin-browser-window-test";
const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const DOCUMENT_ID = "c".repeat(64);

function locationRecord(href: string, exposedOrigin?: string) {
  const parsed = new URL(href);
  return { href: parsed.href, origin: exposedOrigin ?? parsed.origin, protocol: parsed.protocol,
    hostname: parsed.hostname, port: parsed.port, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

function createHostHarness(href: string, exposedOrigin?: string) {
  const listeners = new Map<string, Function[]>();
  let opened: any;
  const host: any = {
    location: locationRecord(href, exposedOrigin),
    addEventListener(type: string, listener: Function) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener(type: string, listener: Function) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener)); },
    open(target: string) {
      const parsed = locationRecord(target, exposedOrigin);
      const document: any = {
        location: parsed,
        body: { replaceChildren(frame: any) { frame.isConnected = true; } },
        createElement() {
          const frame: any = { ownerDocument: document, sandbox: { value: "" }, style: {}, isConnected: false,
            contentWindow: { postMessage() {} }, setAttribute(name: string, value: string) {
              if (name === "sandbox") this.sandbox.value = value;
            }, remove() { this.isConnected = false; } };
          return frame;
        },
      };
      opened = { location: parsed, document };
      opened[SHELL_NAME] = {
        bind: () => true,
        setLocation: () => true,
        postMessage() {},
        dispose() {},
      };
      return opened;
    },
  };
  return {
    host,
    get opened() { return opened; },
    emit(event: unknown) { for (const listener of listeners.get("message") || []) listener(event); },
  };
}

function register(harness: ReturnType<typeof createHostHarness>, onChildMessage = () => true) {
  const host = createPluginNativeBrowserWindowShellHost(harness.host as Window);
  const route = host.register({ sourceBindingId: SOURCE_BINDING, windowId: WINDOW_ID, isCurrent: () => true, onChildMessage });
  return { host, route };
}

function hello(source: unknown, origin: string, ticket: string) {
  return { source, origin, data: { __atools_native_window_shell__: "hello", version: 1, ticket } };
}

function shellHtmlScript(html: string) {
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/i);
  if (!match) throw new Error("native window shell inline script was not found");
  return match[1];
}

function executeShell(script: string, shellHref: string, openerHref: string) {
  const shellLocation = locationRecord(shellHref), openerLocation = locationRecord(openerHref);
  const forwarded: unknown[] = [], sentHello: unknown[][] = [], messageListeners: Function[] = [], childPosts: unknown[][] = [];
  const hostApi = { version: 1, forwardChildMessage: (...args: unknown[]) => { forwarded.push(args); return true; } };
  const opener: any = { location: openerLocation, [HOST_NAME]: hostApi,
    postMessage(message: unknown, targetOrigin: string) {
      if (targetOrigin !== "*") throw new Error("opaque-origin postMessage targetOrigin must be '*'");
      sentHello.push([message, targetOrigin]);
    } };
  const document: any = { body: {}, createElement() { throw new Error("shell must not create a plugin document itself"); } };
  class HTMLIFrameElement {
    ownerDocument = document;
    sandbox = { value: "allow-popups allow-scripts" };
    isConnected = true;
    contentWindow = { postMessage: (...args: unknown[]) => childPosts.push(args) };
    remove() { this.isConnected = false; }
  }
  const frame = new HTMLIFrameElement();
  const self = {};
  const window: any = {};
  const context = vm.createContext({ window, self, top: self, opener, location: shellLocation, document,
    URL, HTMLIFrameElement,
    addEventListener: (name: string, listener: Function) => { if (name === "message") messageListeners.push(listener); },
    removeEventListener: (name: string, listener: Function) => {
      const index = messageListeners.indexOf(listener); if (name === "message" && index >= 0) messageListeners.splice(index, 1);
    },
  });
  vm.runInContext(script, context);
  return { window, frame, opener, forwarded, sentHello, messageListeners, childPosts };
}

afterEach(() => vi.unstubAllGlobals());

describe("native BrowserWindow shell URL identity", () => {
  it("accepts Tauri tuple identity with null or serialized event origin, but still requires source and ticket", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    for (const eventOrigin of ["null", "tauri://localhost"]) {
      const harness = createHostHarness("tauri://localhost/", "tauri://localhost");
      const { route } = register(harness);
      const href = `tauri://localhost/atools-native-window.html#${TICKET}`;
      expect(route.openAuthorized(href)).toBe(true);
      const proxy = harness.opened;

      harness.emit(hello({}, eventOrigin, TICKET));
      harness.emit(hello(proxy, eventOrigin, "d".repeat(64)));
      await expect(route.waitForShell(2)).rejects.toThrow("SHELL_TIMEOUT");

      harness.emit(hello(proxy, eventOrigin, TICKET));
      const shell = await route.waitForShell(50);
      expect(shell.frame.sandbox.value.split(/\s+/).sort().join(" ")).toBe("allow-popups allow-scripts");
      expect(() => shell.setLocation(`atools-plugin://localhost/${SESSION_ID}/index.html?__atools_window_document=${DOCUMENT_ID}`)).not.toThrow();
      route.dispose();
    }
  });

  it("requires the exact HTTP tuple, rejects credentials and keeps HTTP event origins strict", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const harness = createHostHarness("http://localhost:1420/", "http://localhost:1420");
    const { route } = register(harness);
    const ticketedPath = `/atools-native-window.html#${TICKET}`;
    for (const bad of [
      `https://localhost:1420${ticketedPath}`,
      `http://localhost:1421${ticketedPath}`,
      `http://other.test:1420${ticketedPath}`,
      `http://user@localhost:1420${ticketedPath}`,
      `http://localhost:1420/atools-native-window.html?extra=1#${TICKET}`,
      `http://localhost:1420/elsewhere.html#${TICKET}`,
      `http://localhost:1420/atools-native-window.html#invalid`,
    ]) expect(() => route.openAuthorized(bad)).toThrow("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_SHELL_URL");

    expect(route.openAuthorized(`http://localhost:1420${ticketedPath}`)).toBe(true);
    const proxy = harness.opened;
    harness.emit(hello(proxy, "null", TICKET));
    await expect(route.waitForShell(2)).rejects.toThrow("SHELL_TIMEOUT");
    harness.emit(hello(proxy, "http://localhost:1420", TICKET));
    expect((await route.waitForShell(50)).frame).toBeDefined();
    route.dispose();
  });

  it("runs the real shell script with tuple-bound opener checks, strict plugin URLs, and original MessageEvent/Port forwarding", async () => {
    const html = await readFile("public/atools-native-window.html", "utf8");
    const script = shellHtmlScript(html);
    const shellHref = `tauri://localhost/atools-native-window.html#${TICKET}`;
    const sameTuple = executeShell(script, shellHref, "tauri://localhost/index.html");
    expect(sameTuple.sentHello[0][1]).toBe("*");
    const shell = sameTuple.window[SHELL_NAME];
    expect(shell.bind({ ticket: TICKET, nonce: "e".repeat(32), sourceBindingId: SOURCE_BINDING,
      windowId: WINDOW_ID, frame: sameTuple.frame })).toBe(true);
    const wrongPath = executeShell(script, `tauri://localhost/elsewhere.html#${TICKET}`, "tauri://localhost/index.html");
    expect(wrongPath.window[SHELL_NAME].bind({ ticket: TICKET, nonce: "e".repeat(32), sourceBindingId: SOURCE_BINDING,
      windowId: WINDOW_ID, frame: wrongPath.frame })).toBe(false);

    const resourcePath = `/${SESSION_ID}/index.html?__atools_window_document=${DOCUMENT_ID}`;
    for (const allowed of [
      `atools-plugin://localhost${resourcePath}`,
      `http://atools-plugin.localhost${resourcePath}`,
      `https://atools-plugin.localhost${resourcePath}`,
    ]) expect(shell.setLocation(TICKET, "e".repeat(32), allowed)).toBe(true);
    for (const rejected of [
      `atools-plugin://user@localhost${resourcePath}`,
      `atools-plugin://localhost:4400${resourcePath}`,
      `http://atools-plugin.localhost:4400${resourcePath}`,
      `https://atools-plugin.localhost:4400${resourcePath}`,
      `https://elsewhere.test${resourcePath}`,
    ]) expect(shell.setLocation(TICKET, "e".repeat(32), rejected)).toBe(false);

    const channel = new MessageChannel();
    shell.postMessage(TICKET, "e".repeat(32), { probe: true }, "*", [channel.port1]);
    expect(sameTuple.childPosts[0][2]).toEqual([channel.port1]);
    const message = new MessageEvent("message", { data: { probe: true }, origin: "null", source: sameTuple.frame.contentWindow as any });
    sameTuple.messageListeners[0](message);
    expect(sameTuple.forwarded[0][4]).toBe(message);
    sameTuple.messageListeners[0](new MessageEvent("message", { data: {}, origin: "null" }));
    expect(sameTuple.forwarded).toHaveLength(1);

    const unrelatedTuple = executeShell(script, shellHref, "custom-other://localhost/parent.html");
    expect(unrelatedTuple.window[SHELL_NAME].bind({ ticket: TICKET, nonce: "f".repeat(32),
      sourceBindingId: SOURCE_BINDING, windowId: WINDOW_ID, frame: unrelatedTuple.frame })).toBe(false);

    for (const unrelatedParent of [
      "tauri://different-host/index.html",
      "tauri://localhost:1420/index.html",
      "http://localhost/index.html",
    ]) {
      const mismatched = executeShell(script, shellHref, unrelatedParent);
      expect(mismatched.window[SHELL_NAME].bind({ ticket: TICKET, nonce: "f".repeat(32),
        sourceBindingId: SOURCE_BINDING, windowId: WINDOW_ID, frame: mismatched.frame })).toBe(false);
    }

    const httpShellHref = `http://localhost:1420/atools-native-window.html#${TICKET}`;
    const httpParent = executeShell(script, httpShellHref, "http://localhost:1420/index.html");
    expect(httpParent.window[SHELL_NAME].bind({ ticket: TICKET, nonce: "d".repeat(32),
      sourceBindingId: SOURCE_BINDING, windowId: WINDOW_ID, frame: httpParent.frame })).toBe(true);
    expect(httpParent.sentHello[0][1]).toBe("*");
    for (const unrelatedParent of [
      "http://localhost:1421/index.html",
      "http://other.test:1420/index.html",
      "https://localhost:1420/index.html",
    ]) {
      const mismatched = executeShell(script, httpShellHref, unrelatedParent);
      expect(mismatched.window[SHELL_NAME].bind({ ticket: TICKET, nonce: "f".repeat(32),
        sourceBindingId: SOURCE_BINDING, windowId: WINDOW_ID, frame: mismatched.frame })).toBe(false);
    }
  });
});
