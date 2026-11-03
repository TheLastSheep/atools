import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererSettingsViewClient } from "../../packages/ztools-renderer/src/settingsViewClient";
import { createRendererSettingsInput } from "../../packages/ztools-renderer/src/settingsInput";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createTransport(
  handleInvoke: (command: RendererHostCommand, args?: Record<string, unknown>) => unknown | Promise<unknown> = () => undefined,
) {
  const handlers = new Map<string, (payload: unknown) => void>();
  const transport: ZToolsRendererTransport = {
    invoke: vi.fn(async (command, args) => handleInvoke(command, args)),
    listen: vi.fn(async (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
  };
  return {
    transport,
    emit: (payload: unknown) => handlers.get("atools://renderer-settings-view")?.(payload),
  };
}

function inputEvent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "subInput",
    sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bundleRevision: "b".repeat(64),
    generation: 1,
    revision: 1,
    valueVersion: 0,
    action: "set",
    visible: true,
    placeholder: "搜索",
    value: "",
    focus: true,
    ...overrides,
  };
}

function phase(sessionId: string, phaseName: "placeholder" | "opened" | "loaded" | "closed" | "back-to-search") {
  return {
    version: 1,
    sessionId,
    phase: phaseName,
    ...(phaseName === "opened" ? { plugin: {
      name: "setting", title: "设置", logo: "data:image/png;base64,aA==", path: "atools:internal/setting",
      cmdName: "设置", subInputPlaceholder: "搜索", subInputVisible: false,
    } } : {}),
  };
}

function viewClient(transport: ZToolsRendererTransport) {
  return createRendererSettingsViewClient({ invoke: transport.invoke, transport });
}

function settingsViewListenCount(harness: ReturnType<typeof createTransport>): number {
  return vi.mocked(harness.transport.listen).mock.calls.filter(
    ([event]) => event === "atools://renderer-settings-view",
  ).length;
}

describe("renderer settings SubInput adapter", () => {
  it("wires the legacy public callbacks and Main notifier through one settings-view listener", async () => {
    const sessionId = "99999999999999999999999999999999";
    const harness = createTransport((command) => {
      if (command === "open_renderer_settings") return { version: 1, sessionId };
      if (command === "notify_renderer_settings_input") return {
        version: 1, generation: 1, revision: 2, valueVersion: 0, applied: true,
      };
      return undefined;
    });
    const host = createZtoolsRendererHostAdapter({ transport: harness.transport });
    const visible = vi.fn();
    const placeholder = vi.fn();
    const value = vi.fn();
    const focus = vi.fn();
    const select = vi.fn();
    host.api.onUpdateSubInputVisible(visible);
    host.api.onUpdateSubInputPlaceholder(placeholder);
    host.api.onSetSubInputValue(value);
    host.api.onFocusSubInput(focus);
    host.api.onSelectSubInput(select);
    host.api.openSettings();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings", undefined));
    harness.emit(phase(sessionId, "placeholder"));
    harness.emit(phase(sessionId, "opened"));
    harness.emit(inputEvent({ sessionId, focus: false }));
    expect(visible).toHaveBeenCalledWith(true);
    expect(placeholder).toHaveBeenCalledWith({ placeholder: "搜索" });
    expect(value).toHaveBeenCalledWith("");
    harness.emit(inputEvent({ sessionId, action: "select", revision: 2, focus: true }));
    await Promise.resolve();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    host.api.notifySubInputChange("real Main input text");
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith(
      "notify_renderer_settings_input",
      { request: {
        sessionId, bundleRevision: "b".repeat(64), generation: 1, valueVersion: 0, sequence: 1, text: "real Main input text",
      } },
    ));
    await vi.waitFor(() => expect(host.snapshot().settingsView.input.notifyInFlight).toBe(false));
    expect(host.snapshot().settingsView.input).toEqual({
      callbacks: 5,
      invalidPayloads: 0,
      stalePayloads: 0,
      callbackErrors: 0,
      notifyFailures: 0,
      staleReplies: 0,
      notifyPending: false,
      notifyInFlight: false,
      disposed: false,
    });
    expect(settingsViewListenCount(harness)).toBe(1);
    expect(host.capabilities().methods.notifySubInputChange).toBe("limited");
    for (const eventName of [
      "onUpdateSubInputVisible", "onUpdateSubInputPlaceholder", "onSetSubInputValue", "onFocusSubInput", "onSelectSubInput",
    ]) expect(host.capabilities().events[eventName]).toBe("limited");
    host.dispose();
  });

  it("buffers an early packet until opened and shares the existing settings listener", async () => {
    const sessionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const openReply = deferred<unknown>();
    const harness = createTransport((command) => command === "open_renderer_settings" ? openReply.promise : undefined);
    const client = viewClient(harness.transport);
    const observed: unknown[] = [];
    client.subscribe("onPluginOpened", () => observed.push("opened"));
    client.subscribeInput("onUpdateSubInputVisible", (value) => observed.push(["visible", value]));
    client.subscribeInput("onUpdateSubInputPlaceholder", (value) => observed.push(["placeholder", value]));
    client.subscribeInput("onSetSubInputValue", (value) => observed.push(["value", value]));
    client.subscribeInput("onFocusSubInput", () => observed.push("focus"));
    client.open();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings"));
    expect(settingsViewListenCount(harness)).toBe(1);

    harness.emit(inputEvent({ sessionId }));
    expect(observed).toEqual([]);
    harness.emit(phase(sessionId, "placeholder"));
    harness.emit(phase(sessionId, "opened"));
    expect(observed).toEqual([
      "opened",
      ["visible", true],
      ["placeholder", { placeholder: "搜索" }],
      ["value", ""],
    ]);
    await Promise.resolve();
    expect(observed.at(-1)).toBe("focus");
    openReply.resolve({ version: 1, sessionId });
    await vi.waitFor(() => expect(client.snapshot().pendingOpen).toBe(false));
    expect(settingsViewListenCount(harness)).toBe(1);
    client.dispose();
  });

  it("keeps the selected opening session packet when a different session packet arrives", async () => {
    const selectedSession = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const otherSession = "ffffffffffffffffffffffffffffffff";
    const openReply = deferred<unknown>();
    const harness = createTransport((command) => command === "open_renderer_settings" ? openReply.promise : undefined);
    const client = viewClient(harness.transport);
    const values: string[] = [];
    client.subscribeInput("onSetSubInputValue", (value) => values.push(value));
    client.open();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings"));

    harness.emit(phase(selectedSession, "placeholder"));
    harness.emit(inputEvent({ sessionId: selectedSession, value: "selected" }));
    harness.emit(inputEvent({ sessionId: otherSession, value: "other session" }));
    expect(client.snapshot().input.stalePayloads).toBe(1);
    harness.emit(phase(selectedSession, "opened"));
    expect(values).toEqual(["selected"]);

    openReply.resolve({ version: 1, sessionId: selectedSession });
    await vi.waitFor(() => expect(client.snapshot().pendingOpen).toBe(false));
    client.dispose();
  });

  it("allows a new opening session packet before its placeholder after the previous session closed", async () => {
    const oldSession = "12121212121212121212121212121212";
    const newSession = "34343434343434343434343434343434";
    const newOpenReply = deferred<unknown>();
    let openCount = 0;
    const harness = createTransport((command) => {
      if (command !== "open_renderer_settings") return undefined;
      openCount += 1;
      return openCount === 1 ? { version: 1, sessionId: oldSession } : newOpenReply.promise;
    });
    const client = viewClient(harness.transport);
    const values: string[] = [];
    client.subscribeInput("onSetSubInputValue", (value) => values.push(value));
    client.open();
    await vi.waitFor(() => expect(openCount).toBe(1));
    harness.emit(phase(oldSession, "placeholder"));
    harness.emit(phase(oldSession, "opened"));
    harness.emit(phase(oldSession, "closed"));

    client.open();
    await vi.waitFor(() => expect(openCount).toBe(2));
    harness.emit(inputEvent({ sessionId: newSession, value: "new session" }));
    expect(values).toEqual([]);
    harness.emit(phase(newSession, "placeholder"));
    harness.emit(phase(newSession, "opened"));
    expect(values).toEqual(["new session"]);

    newOpenReply.resolve({ version: 1, sessionId: newSession });
    await vi.waitFor(() => expect(client.snapshot().pendingOpen).toBe(false));
    client.dispose();
  });

  it("clears a queued close after open failure instead of closing the next session", async () => {
    const nextSession = "56565656565656565656565656565656";
    const failedOpen = deferred<unknown>();
    const successfulOpen = deferred<unknown>();
    let openCount = 0;
    const harness = createTransport((command) => {
      if (command !== "open_renderer_settings") return undefined;
      openCount += 1;
      return openCount === 1 ? failedOpen.promise : successfulOpen.promise;
    });
    const client = viewClient(harness.transport);
    client.subscribeInput("onUpdateSubInputVisible", () => undefined);

    client.open();
    await vi.waitFor(() => expect(openCount).toBe(1));
    client.close("main-hide");
    failedOpen.reject(new Error("first open failed"));
    await vi.waitFor(() => expect(client.snapshot().pendingOpen).toBe(false));
    expect(client.snapshot().openFailures).toBe(1);

    client.open();
    await vi.waitFor(() => expect(openCount).toBe(2));
    successfulOpen.resolve({ version: 1, sessionId: nextSession });
    await vi.waitFor(() => expect(client.snapshot().pendingOpen).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(harness.transport.invoke).mock.calls.filter(([command]) => command === "close_renderer_settings")).toHaveLength(0);
    expect(client.snapshot().activePhase).toBe("open-requested");
    client.dispose();
  });

  it("strictly rejects malformed, stale, retired and close-cancelled state without stale focus", async () => {
    const sessionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const harness = createTransport((command) => command === "open_renderer_settings" ? { version: 1, sessionId } : undefined);
    const client = viewClient(harness.transport);
    const observed: unknown[] = [];
    client.subscribeInput("onUpdateSubInputVisible", (value) => observed.push(["visible", value]));
    client.subscribeInput("onUpdateSubInputPlaceholder", (value) => observed.push(["placeholder", value]));
    client.subscribeInput("onSetSubInputValue", (value) => observed.push(["value", value]));
    client.subscribeInput("onFocusSubInput", () => observed.push("focus"));
    client.subscribeInput("onSelectSubInput", () => observed.push("select"));
    client.open();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings"));
    harness.emit(phase(sessionId, "placeholder"));
    harness.emit(phase(sessionId, "opened"));

    harness.emit(inputEvent({ sessionId, action: "select", focus: true, revision: 1 }));
    await Promise.resolve();
    expect(observed.slice(-2)).toEqual(["focus", "select"]);
    harness.emit({ ...inputEvent({ sessionId, revision: 2 }), unexpected: true });
    harness.emit(inputEvent({ sessionId, revision: 1, value: "stale" }));
    expect(client.inputSnapshot()).toMatchObject({ invalidPayloads: 1, stalePayloads: 1 });
    expect(observed).not.toContain(["value", "stale"]);

    const focusCount = observed.filter((item) => item === "focus").length;
    harness.emit(inputEvent({ sessionId, action: "value", revision: 3, valueVersion: 1, value: "before remove" }));
    harness.emit(inputEvent({ sessionId, action: "remove", generation: 2, revision: 4, visible: false, focus: false }));
    await Promise.resolve();
    expect(observed.filter((item) => item === "focus")).toHaveLength(focusCount);
    expect(observed.at(-1)).toEqual(["visible", false]);
    harness.emit(inputEvent({ sessionId, generation: 1, revision: 5, value: "old generation" }));
    expect(client.inputSnapshot().stalePayloads).toBe(2);
    harness.emit(phase(sessionId, "closed"));
    harness.emit(inputEvent({ sessionId, generation: 3, revision: 6, value: "after close" }));
    expect(client.inputSnapshot().stalePayloads).toBe(3);
    client.dispose();
    expect(client.inputSnapshot()).toMatchObject({ callbacks: 0, disposed: true });
  });

  it("coalesces same-tick Main text and holds at most one latest value behind one invoke", async () => {
    const sessionId = "cccccccccccccccccccccccccccccccc";
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let notifyCount = 0;
    const harness = createTransport((command) => {
      if (command === "open_renderer_settings") return { version: 1, sessionId };
      if (command === "notify_renderer_settings_input") return ++notifyCount === 1 ? first.promise : second.promise;
      return undefined;
    });
    const client = viewClient(harness.transport);
    client.subscribeInput("onUpdateSubInputVisible", () => undefined);
    client.open();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings"));
    harness.emit(phase(sessionId, "placeholder"));
    harness.emit(phase(sessionId, "opened"));
    harness.emit(inputEvent({ sessionId, revision: 1, focus: false }));

    client.notifySubInputChange("first");
    client.notifySubInputChange("latest same tick");
    await vi.waitFor(() => expect(notifyCount).toBe(1));
    const firstCall = vi.mocked(harness.transport.invoke).mock.calls.filter(([command]) => command === "notify_renderer_settings_input")[0];
    expect(firstCall[1]).toEqual({ request: {
      sessionId, bundleRevision: "b".repeat(64), generation: 1, valueVersion: 0, sequence: 2, text: "latest same tick",
    } });

    client.notifySubInputChange("intermediate");
    client.notifySubInputChange("latest pending");
    expect(notifyCount).toBe(1);
    expect(client.inputSnapshot()).toMatchObject({ notifyPending: true, notifyInFlight: true });
    first.resolve({ version: 1, generation: 1, revision: 2, valueVersion: 0, applied: true });
    await vi.waitFor(() => expect(notifyCount).toBe(2));
    const secondCall = vi.mocked(harness.transport.invoke).mock.calls.filter(([command]) => command === "notify_renderer_settings_input")[1];
    expect(secondCall[1]).toEqual({ request: {
      sessionId, bundleRevision: "b".repeat(64), generation: 1, valueVersion: 0, sequence: 4, text: "latest pending",
    } });
    second.resolve({ version: 1, generation: 1, revision: 3, valueVersion: 0, applied: false });
    await vi.waitFor(() => expect(client.inputSnapshot()).toMatchObject({ notifyFailures: 1, notifyInFlight: false }));
    expect(notifyCount).toBe(2);
    client.dispose();
  });

  it("rejects a JSON-escaped request over 32 KiB before invoke and counts the failure", async () => {
    const sessionId = "78787878787878787878787878787878";
    const harness = createTransport((command) => command === "notify_renderer_settings_input"
      ? { version: 1, generation: 1, revision: 2, valueVersion: 0, applied: true }
      : command === "open_renderer_settings" ? { version: 1, sessionId } : undefined);
    const client = viewClient(harness.transport);
    client.subscribeInput("onUpdateSubInputVisible", () => undefined);
    client.open();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings"));
    harness.emit(phase(sessionId, "placeholder"));
    harness.emit(phase(sessionId, "opened"));
    harness.emit(inputEvent({ sessionId, focus: false }));

    const escapedText = "\0".repeat(5_500);
    expect(new TextEncoder().encode(escapedText).byteLength).toBeLessThan(16 * 1024);
    expect(new TextEncoder().encode(JSON.stringify({
      sessionId,
      bundleRevision: "b".repeat(64),
      generation: 1,
      valueVersion: 0,
      sequence: 1,
      text: escapedText,
    })).byteLength).toBeGreaterThan(32 * 1024);
    client.notifySubInputChange(escapedText);
    await Promise.resolve();
    expect(vi.mocked(harness.transport.invoke).mock.calls.filter(([command]) => command === "notify_renderer_settings_input")).toHaveLength(0);
    expect(client.snapshot().input).toMatchObject({ notifyFailures: 1, notifyPending: false, notifyInFlight: false });

    client.notifySubInputChange("accepted");
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("notify_renderer_settings_input", {
      request: {
        sessionId,
        bundleRevision: "b".repeat(64),
        generation: 1,
        valueVersion: 0,
        sequence: 1,
        text: "accepted",
      },
    }));
    client.dispose();
  });

  it("drops an unresolved latest input and ignores a late reply after disposal", async () => {
    const sessionId = "dddddddddddddddddddddddddddddddd";
    const reply = deferred<unknown>();
    const harness = createTransport((command) => command === "open_renderer_settings"
      ? { version: 1, sessionId }
      : command === "notify_renderer_settings_input" ? reply.promise : undefined);
    const client = viewClient(harness.transport);
    client.subscribeInput("onUpdateSubInputVisible", () => undefined);
    client.open();
    await vi.waitFor(() => expect(harness.transport.invoke).toHaveBeenCalledWith("open_renderer_settings"));
    harness.emit(phase(sessionId, "placeholder"));
    harness.emit(phase(sessionId, "opened"));
    harness.emit(inputEvent({ sessionId, focus: false }));
    client.notifySubInputChange("queued");
    await vi.waitFor(() => expect(client.inputSnapshot().notifyInFlight).toBe(true));
    client.dispose();
    expect(client.inputSnapshot()).toMatchObject({ notifyPending: false, notifyInFlight: false, disposed: true });
    reply.resolve({ version: 1, generation: 1, revision: 2, valueVersion: 0, applied: true });
    await Promise.resolve();
    expect(client.inputSnapshot().notifyFailures).toBe(0);
  });
});
