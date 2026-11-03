import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRendererSettingsViewClient,
  type RendererSettingsViewEvent,
} from "../../packages/ztools-renderer/src/settingsViewClient";
import {
  createRendererGeneralPreferenceEvents,
} from "../../packages/ztools-renderer/src/generalPreferenceEvents";
import { createTauriTransport } from "../../packages/ztools-renderer/src/tauriTransport";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

const { tauriListen } = vi.hoisted(() => ({ tauriListen: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({ listen: tauriListen }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settingsSession(sessionId: string) {
  return { version: 1, sessionId };
}

function settingsPlugin(logo = "data:image/png;base64,aA==") {
  return {
    name: "setting",
    title: "设置",
    logo,
    path: "atools:internal/setting",
    cmdName: "设置",
    subInputPlaceholder: "搜索",
    subInputVisible: false,
  };
}

function settingsEvent(
  sessionId: string,
  phase: RendererSettingsViewEvent["phase"],
  plugin?: ReturnType<typeof settingsPlugin>,
): RendererSettingsViewEvent {
  return {
    version: 1,
    sessionId,
    phase,
    ...(plugin ? { plugin } : {}),
  } as RendererSettingsViewEvent;
}

function settingsClient(transport: ZToolsRendererTransport) {
  return createRendererSettingsViewClient({
    invoke: (command, args) => transport.invoke(command, args),
    transport,
  });
}

function createTransport(options: {
  invoke?: (command: RendererHostCommand, args?: Record<string, unknown>) => unknown | Promise<unknown>;
  listen?: (event: string, handler: (payload: unknown) => void) => Promise<() => void> | (() => void);
} = {}): ZToolsRendererTransport & {
  emit(event: string, payload: unknown): void;
  eventState(event: string): { registrations: number; active: number; removals: number };
} {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const registrations = new Map<string, number>();
  const removals = new Map<string, number>();
  return {
    invoke: vi.fn(async (command, args) => options.invoke?.(command, args)),
    listen: vi.fn(async (event, handler) => {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
      registrations.set(event, (registrations.get(event) ?? 0) + 1);
      const remove = () => {
        listeners.delete(handler);
        removals.set(event, (removals.get(event) ?? 0) + 1);
      };
      if (options.listen) {
        const unlisten = await options.listen(event, handler);
        return () => { remove(); unlisten(); };
      }
      return remove;
    }),
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    eventState(event) {
      return {
        registrations: registrations.get(event) ?? 0,
        active: handlers.get(event)?.size ?? 0,
        removals: removals.get(event) ?? 0,
      };
    },
  };
}

afterEach(() => {
  tauriListen.mockReset();
});

describe("renderer settings view lifecycle client", () => {
  it("subscribes before opening, coalesces opens, and accepts phases arriving before the RPC reply", async () => {
    const sessionId = "0123456789abcdef0123456789abcdef";
    const openReply = deferred<unknown>();
    const listenGate = deferred<() => void>();
    const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
    const transport = createTransport({
      invoke: async (command, args) => {
        calls.push({ command, args });
        return openReply.promise;
      },
      listen: () => listenGate.promise,
    });
    const client = settingsClient(transport);
    const placeholder = vi.fn();
    const opened = vi.fn();
    const loaded = vi.fn();
    client.open();
    client.open();
    client.subscribe("onShowPluginPlaceholder", placeholder);
    client.subscribe("onPluginOpened", opened);
    client.subscribe("onPluginLoaded", loaded);
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(0);
    listenGate.resolve(vi.fn());
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(transport.listen).toHaveBeenCalledTimes(1);
    expect(transport.listen).toHaveBeenCalledWith(
      "atools://renderer-settings-view",
      expect.any(Function),
    );

    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "placeholder"));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "opened", settingsPlugin()));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "loaded"));
    expect(placeholder).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(settingsPlugin());
    expect(loaded).toHaveBeenCalledWith({ name: "setting", path: "atools:internal/setting" });

    openReply.resolve(settingsSession(sessionId));
    await vi.waitFor(() => expect(client.snapshot().pendingOpen).toBe(false));
    client.open();
    expect(calls).toHaveLength(1);
    expect(client.snapshot().activePhase).toBe("loaded");
    client.dispose();
  });

  it("rejects unknown phases and forged settings plugin payloads without notifying the UI", async () => {
    const sessionId = "11111111111111111111111111111111";
    const transport = createTransport({ invoke: async () => settingsSession(sessionId) });
    const client = settingsClient(transport);
    const opened = vi.fn();
    client.subscribe("onPluginOpened", opened);
    client.open();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(1));

    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "placeholder"));
    transport.emit("atools://renderer-settings-view", {
      version: 1,
      sessionId,
      phase: "unknown-phase",
    });
    transport.emit("atools://renderer-settings-view", settingsEvent(
      sessionId,
      "opened",
      { ...settingsPlugin(), path: "/tmp/forged-plugin" },
    ));
    expect(opened).not.toHaveBeenCalled();
    expect(client.snapshot().invalidPayloads).toBe(2);
    client.dispose();
  });

  it("fences stale sessions and does not re-fire duplicate ready phases", async () => {
    const first = "22222222222222222222222222222222";
    const second = "33333333333333333333333333333333";
    let opens = 0;
    const transport = createTransport({
      invoke: async (command) => command === "open_renderer_settings"
        ? settingsSession(++opens === 1 ? first : second)
        : undefined,
    });
    const client = settingsClient(transport);
    const placeholder = vi.fn();
    const opened = vi.fn();
    const loaded = vi.fn();
    const closed = vi.fn();
    const back = vi.fn();
    client.subscribe("onShowPluginPlaceholder", placeholder);
    client.subscribe("onPluginOpened", opened);
    client.subscribe("onPluginLoaded", loaded);
    client.subscribe("onPluginClosed", closed);
    client.subscribe("onBackToSearch", back);
    client.open();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(1));

    transport.emit("atools://renderer-settings-view", settingsEvent(first, "placeholder"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "opened", settingsPlugin()));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "opened", settingsPlugin()));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "loaded"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "loaded"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "closed"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "back-to-search"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "back-to-search"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "placeholder"));
    expect(placeholder).toHaveBeenCalledTimes(1);

    client.open();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(2));
    transport.emit("atools://renderer-settings-view", settingsEvent(second, "placeholder"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "placeholder"));
    transport.emit("atools://renderer-settings-view", settingsEvent(first, "opened", settingsPlugin()));
    transport.emit("atools://renderer-settings-view", settingsEvent(second, "opened", settingsPlugin()));
    expect(placeholder).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(back).toHaveBeenCalledTimes(1);
    expect(client.snapshot().activePhase).toBe("opened");
    client.dispose();
  });

  it("closes the active setting session with the required reason and records command failures", async () => {
    const sessionId = "44444444444444444444444444444444";
    const transport = createTransport({
      invoke: async (command) => {
        if (command === "open_renderer_settings") return settingsSession(sessionId);
        throw new Error("native close failed");
      },
    });
    const client = settingsClient(transport);
    const placeholder = vi.fn();
    const closed = vi.fn();
    const back = vi.fn();
    client.subscribe("onShowPluginPlaceholder", placeholder);
    client.subscribe("onPluginClosed", closed);
    client.subscribe("onBackToSearch", back);
    client.open();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledTimes(1));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "placeholder"));
    expect(placeholder).toHaveBeenCalledTimes(1);

    client.close("main-hide");
    await vi.waitFor(() => expect(client.snapshot().closeFailures).toBe(1));
    expect(transport.invoke).toHaveBeenLastCalledWith("close_renderer_settings", {
      sessionId,
      reason: "main-hide",
    });
    expect(client.snapshot().closeFailures).toBe(1);
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "closed"));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "back-to-search"));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "placeholder"));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(placeholder).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("closes the session returned after a hide request during the pending open", async () => {
    const sessionId = "49494949494949494949494949494949";
    const openReply = deferred<unknown>();
    const transport = createTransport({
      invoke: async (command) => command === "open_renderer_settings" ? openReply.promise : undefined,
    });
    const client = settingsClient(transport);
    client.open();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("open_renderer_settings", undefined));

    client.close("main-hide");
    openReply.resolve(settingsSession(sessionId));
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("close_renderer_settings", {
      sessionId,
      reason: "main-hide",
    }));
    client.dispose();
  });

  it("unlistens when async registration resolves after disposal and counts registration failures", async () => {
    const listenGate = deferred<() => void>();
    const unlisten = vi.fn();
    const transport = createTransport({ listen: () => listenGate.promise });
    const client = settingsClient(transport);
    client.subscribe("onBackToSearch", vi.fn());
    client.dispose();
    listenGate.resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    expect(client.snapshot()).toMatchObject({ listenerState: "disposed", lateListenerUnlistens: 1 });

    const failedTransport = createTransport({
      listen: async () => { throw new Error("listen denied"); },
      invoke: async () => settingsSession("55555555555555555555555555555555"),
    });
    const failed = settingsClient(failedTransport);
    failed.open();
    await vi.waitFor(() => expect(failed.snapshot().registrationErrors).toBe(1));
    expect(failedTransport.invoke).not.toHaveBeenCalled();
    expect(failed.snapshot().openFailures).toBe(1);
    failed.dispose();
  });
});

describe("renderer General preference event bridge", () => {
  it("notifies only the validated five General fields and never exposes unrelated settings", async () => {
    const transport = createTransport();
    const client = createRendererGeneralPreferenceEvents(transport);
    const placeholder = vi.fn();
    const autoClear = vi.fn();
    const primaryColor = vi.fn();
    client.subscribe("onUpdatePlaceholder", placeholder);
    client.subscribe("onUpdateAutoClear", autoClear);
    client.subscribe("onUpdatePrimaryColor", primaryColor);
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledTimes(1));

    transport.emit("atools://renderer-general-settings", {
      version: 1,
      raw: JSON.stringify({
        placeholder: "Search here",
        autoClear: "never",
        primaryColor: "custom",
        customColor: "#AABBCC",
        theme: "dark",
        aiApiKey: "do-not-forward",
        privateToken: "also-secret",
      }),
    });
    expect(placeholder).toHaveBeenCalledWith("Search here");
    expect(autoClear).toHaveBeenCalledWith("never");
    expect(primaryColor).toHaveBeenCalledWith({ primaryColor: "custom", customColor: "#AABBCC" });
    expect(JSON.stringify([placeholder.mock.calls, autoClear.mock.calls, primaryColor.mock.calls]))
      .not.toContain("do-not-forward");
    expect(client.snapshot().notifiedFields).toEqual({ placeholder: 1 });
    client.dispose();
  });

  it("reads legacy placeholders above the write limit and still notifies primary color", async () => {
    const transport = createTransport();
    const client = createRendererGeneralPreferenceEvents(transport);
    const placeholder = vi.fn();
    const primaryColor = vi.fn();
    client.subscribe("onUpdatePlaceholder", placeholder);
    client.subscribe("onUpdatePrimaryColor", primaryColor);
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledTimes(1));

    const legacyPlaceholder = "x".repeat(513);
    transport.emit("atools://renderer-general-settings", {
      version: 1,
      raw: JSON.stringify({ placeholder: legacyPlaceholder, primaryColor: "green" }),
    });
    expect(placeholder).toHaveBeenCalledWith(legacyPlaceholder);
    expect(primaryColor).toHaveBeenCalledWith({ primaryColor: "green" });

    transport.emit("atools://renderer-general-settings", {
      version: 1,
      raw: JSON.stringify({ placeholder: 513, primaryColor: "red" }),
    });
    expect(placeholder).toHaveBeenCalledTimes(1);
    expect(primaryColor).toHaveBeenCalledTimes(1);
    expect(client.snapshot()).toMatchObject({ invalidPayloads: 1, notifiedFields: { placeholder: 1 } });
    client.dispose();
  });

  it("rejects malformed selected values atomically and bounds native raw payloads", async () => {
    const transport = createTransport();
    const client = createRendererGeneralPreferenceEvents(transport);
    const placeholder = vi.fn();
    const autoClear = vi.fn();
    client.subscribe("onUpdatePlaceholder", placeholder);
    client.subscribe("onUpdateAutoClear", autoClear);
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledTimes(1));

    transport.emit("atools://renderer-general-settings", {
      version: 1,
      raw: JSON.stringify({ placeholder: "safe", autoClear: "sometimes", privateToken: "secret" }),
    });
    transport.emit("atools://renderer-general-settings", {
      version: 1,
      raw: " ".repeat(64 * 1024 + 1),
    });
    expect(placeholder).not.toHaveBeenCalled();
    expect(autoClear).not.toHaveBeenCalled();
    expect(client.snapshot().invalidPayloads).toBe(2);
    client.dispose();
  });
});

describe("Tauri renderer event target routing", () => {
  it("listens to lifecycle and General preferences on the main Webview and focus on the main Window", async () => {
    tauriListen.mockImplementation(async (_event, _handler, _options) => () => undefined);
    const transport = createTauriTransport();
    const callback = vi.fn();
    for (const [event, kind] of [
      ["atools://renderer-settings-view", "Webview"],
      ["atools://renderer-general-settings", "Webview"],
      ["atools://renderer-app-state", "Webview"],
      ["tauri://focus", "Window"],
      ["atools://renderer-context-menu", "Window"],
    ] as const) {
      await transport.listen(event, callback);
      expect(tauriListen).toHaveBeenLastCalledWith(event, expect.any(Function), {
        target: { kind, label: "main" },
      });
    }
    await expect(transport.listen("atools://unapproved", callback)).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
  });
});

describe("settings and General preference host API wiring", () => {
  it("uses the original API methods for settings lifecycle and forwards only the General UI updates", async () => {
    const sessionId = "66666666666666666666666666666666";
    const transport = createTransport({
      invoke: async (command) => command === "open_renderer_settings" ? settingsSession(sessionId) : undefined,
    });
    const adapter = createZtoolsRendererHostAdapter({ transport });
    const placeholder = vi.fn();
    const opened = vi.fn();
    const loaded = vi.fn();
    const closed = vi.fn();
    const back = vi.fn();
    const placeholderUpdate = vi.fn();
    const autoClearUpdate = vi.fn();
    const colorUpdate = vi.fn();
    adapter.api.onShowPluginPlaceholder(placeholder);
    adapter.api.onPluginOpened(opened);
    adapter.api.onPluginLoaded(loaded);
    adapter.api.onPluginClosed(closed);
    adapter.api.onBackToSearch(back);
    adapter.api.onUpdatePlaceholder(placeholderUpdate);
    adapter.api.onUpdateAutoClear(autoClearUpdate);
    adapter.api.onUpdatePrimaryColor(colorUpdate);
    await vi.waitFor(() => expect(transport.eventState("atools://renderer-settings-view").active).toBe(1));
    expect(transport.eventState("atools://renderer-settings-view")).toMatchObject({ registrations: 1, active: 1 });
    expect(transport.eventState("atools://renderer-general-settings")).toMatchObject({ registrations: 1, active: 1 });
    expect(transport.eventState("atools://renderer-apps-changed")).toMatchObject({ registrations: 1, active: 1 });

    adapter.api.openSettings();
    adapter.api.openSettings();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("open_renderer_settings", undefined));
    expect(transport.invoke).toHaveBeenCalledTimes(1);
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "placeholder"));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "opened", settingsPlugin()));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "loaded"));
    expect(placeholder).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(settingsPlugin());
    expect(loaded).toHaveBeenCalledWith({ name: "setting", path: "atools:internal/setting" });

    transport.emit("atools://renderer-general-settings", {
      version: 1,
      raw: JSON.stringify({
        placeholder: "Search here",
        autoClear: "never",
        primaryColor: "custom",
        customColor: "#123456",
        theme: "dark",
        privateToken: "never-forward",
      }),
    });
    expect(placeholderUpdate).toHaveBeenCalledWith("Search here");
    expect(autoClearUpdate).toHaveBeenCalledWith("never");
    expect(colorUpdate).toHaveBeenCalledWith({ primaryColor: "custom", customColor: "#123456" });
    expect(JSON.stringify([placeholderUpdate.mock.calls, autoClearUpdate.mock.calls, colorUpdate.mock.calls]))
      .not.toContain("never-forward");

    adapter.api.hidePlugin();
    await vi.waitFor(() => expect(transport.invoke).toHaveBeenCalledWith("close_renderer_settings", {
      sessionId,
      reason: "main-hide",
    }));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "closed"));
    transport.emit("atools://renderer-settings-view", settingsEvent(sessionId, "back-to-search"));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(adapter.capabilities()).toMatchObject({
      methods: { openSettings: "limited", hidePlugin: "limited" },
      methodNotes: { openSettings: expect.stringContaining("internal settings") },
      events: { onPluginOpened: "limited", onUpdatePrimaryColor: "limited" },
    });
    await expect(adapter.api.launch({ type: "plugin", path: "/community/plugin" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    adapter.dispose();
    for (const event of [
      "atools://renderer-settings-view",
      "atools://renderer-general-settings",
      "atools://renderer-apps-changed",
    ]) expect(transport.eventState(event)).toEqual({ registrations: 1, active: 0, removals: 1 });
  });
});
