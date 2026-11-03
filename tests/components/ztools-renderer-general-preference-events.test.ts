import { describe, expect, it, vi } from "vitest";
import {
  GENERAL_RENDERER_WRITE_FIELDS,
  isGeneralPreferenceValue,
} from "../../packages/ztools-renderer/src/generalPreferenceSchema";
import {
  createRendererGeneralPreferenceEvents,
  RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS,
} from "../../packages/ztools-renderer/src/generalPreferenceEvents";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type {
  RendererHostCommand,
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const GENERAL_EVENT = "atools://renderer-general-settings";
const APP_EVENT = "atools://renderer-apps-changed";

function eventTransport() {
  const listeners = new Map<string, Set<RendererHostListener>>();
  const registrations = new Map<string, number>();
  const removals = new Map<string, number>();
  const listen = vi.fn(async (event: string, handler: RendererHostListener): Promise<RendererHostUnlisten> => {
    const handlers = listeners.get(event) ?? new Set();
    handlers.add(handler);
    listeners.set(event, handlers);
    registrations.set(event, (registrations.get(event) ?? 0) + 1);
    return () => {
      handlers.delete(handler);
      removals.set(event, (removals.get(event) ?? 0) + 1);
    };
  });
  const transport: ZToolsRendererTransport = {
    invoke: vi.fn(async (_command: RendererHostCommand) => undefined),
    listen,
  };
  return {
    transport,
    listeners,
    listen,
    registrationCount: (event: string) => registrations.get(event) ?? 0,
    activeCount: (event: string) => listeners.get(event)?.size ?? 0,
    removalCount: (event: string) => removals.get(event) ?? 0,
    emit(event: string, payload: unknown) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    emitRaw(raw: Record<string, unknown>) {
      for (const handler of [...(listeners.get(GENERAL_EVENT) ?? [])]) {
        handler({ version: 1, raw: JSON.stringify(raw) });
      }
    },
  };
}

async function expectAdapterEventListeners(fixture: ReturnType<typeof eventTransport>): Promise<void> {
  await vi.waitFor(() => expect(fixture.activeCount(GENERAL_EVENT)).toBe(1));
  expect(fixture.registrationCount(GENERAL_EVENT)).toBe(1);
  expect(fixture.activeCount(APP_EVENT)).toBe(1);
  expect(fixture.registrationCount(APP_EVENT)).toBe(1);
}

function expectAdapterEventListenersDisposed(fixture: ReturnType<typeof eventTransport>): void {
  for (const event of [GENERAL_EVENT, APP_EVENT]) {
    expect(fixture.activeCount(event)).toBe(0);
    expect(fixture.removalCount(event)).toBe(1);
  }
}

describe("ZTools renderer General preference events", () => {
  it("derives callback aliases and validates the auto-paste enum", () => {
    expect(isGeneralPreferenceValue("localAppSearch", false)).toBe(true);
    expect(isGeneralPreferenceValue("localAppSearch", "false")).toBe(false);
    expect(GENERAL_RENDERER_WRITE_FIELDS.has("localAppSearch")).toBe(false);
    expect(GENERAL_RENDERER_WRITE_FIELDS.has("autoPaste")).toBe(false);
    expect(["off", "1s", "3s", "5s", "10s"].every((value) => isGeneralPreferenceValue("autoPaste", value))).toBe(true);
    expect(["never", "0s", "2s", 3000, true, null].every((value) => !isGeneralPreferenceValue("autoPaste", value))).toBe(true);
    expect(RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS).toEqual([
      ["placeholder", "onUpdatePlaceholder"],
      ["primaryColor", "onUpdatePrimaryColor"],
      ["autoClear", "onUpdateAutoClear"],
      ["showRecentInSearch", "onUpdateShowRecentInSearch"],
      ["recentRows", "onUpdateRecentRows"],
      ["pinnedRows", "onUpdatePinnedRows"],
      ["searchMode", "onUpdateSearchMode"],
      ["showMatchRecommendation", "onUpdateMatchRecommendation"],
      ["tabKeyFunction", "onUpdateTabKeyFunction"],
      ["tabTargetCommand", "onUpdateTabTarget"],
      ["spaceOpenCommand", "onUpdateSpaceOpenCommand"],
      ["localAppSearch", "onUpdateLocalAppSearch"],
      ["autoPaste", "onUpdateAutoPaste"],
      ["builtinAppShortcutsEnabled", "onUpdateBuiltinAppShortcutsEnabled"],
      ["autoCheckUpdate", "onAutoCheckUpdateChanged"],
    ]);
  });

  it("accepts integral decimal JSON row tokens and rejects non-integers and wrong types", async () => {
    const fixture = eventTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const recentRows = vi.fn();
    const pinnedRows = vi.fn();
    adapter.api.onUpdateRecentRows(recentRows);
    adapter.api.onUpdatePinnedRows(pinnedRows);
    await expectAdapterEventListeners(fixture);

    fixture.emit(GENERAL_EVENT, {
      version: 1,
      raw: '{"recentRows":2.0,"pinnedRows":-0.0,"unknownSecret":"row-event-secret"}',
    });
    expect(recentRows).toHaveBeenCalledTimes(1);
    expect(recentRows.mock.calls[0][0]).toBe(2);
    expect(pinnedRows).toHaveBeenCalledTimes(1);
    expect(pinnedRows.mock.calls[0][0] === 0).toBe(true);

    for (const raw of [
      '{"recentRows":2.5}',
      '{"pinnedRows":21}',
      '{"recentRows":"2"}',
      '{"pinnedRows":true}',
    ]) fixture.emit(GENERAL_EVENT, { version: 1, raw });
    expect(recentRows).toHaveBeenCalledTimes(1);
    expect(pinnedRows).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().generalPreferenceEvents).toMatchObject({ invalidPayloads: 4 });
    expect(JSON.stringify({ calls: [recentRows.mock.calls, pinnedRows.mock.calls], snapshot: adapter.snapshot() }))
      .not.toContain("row-event-secret");
    adapter.dispose();
    expectAdapterEventListenersDisposed(fixture);
  });

  it("forwards typed fields through one native listener", async () => {
    const fixture = eventTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const callbacks = {
      placeholder: vi.fn(),
      autoPaste: vi.fn(),
      autoClear: vi.fn(),
      primaryColor: vi.fn(),
      showRecentInSearch: vi.fn(),
      recentRows: vi.fn(),
      pinnedRows: vi.fn(),
      searchMode: vi.fn(),
      matchRecommendation: vi.fn(),
      tabKeyFunction: vi.fn(),
      tabTarget: vi.fn(),
      spaceOpenCommand: vi.fn(),
      localAppSearch: vi.fn(),
    };
    const stops = [
      adapter.api.onUpdatePlaceholder(callbacks.placeholder),
      adapter.api.onUpdateAutoPaste(callbacks.autoPaste),
      adapter.api.onUpdateAutoClear(callbacks.autoClear),
      adapter.api.onUpdatePrimaryColor(callbacks.primaryColor),
      adapter.api.onUpdateShowRecentInSearch(callbacks.showRecentInSearch),
      adapter.api.onUpdateRecentRows(callbacks.recentRows),
      adapter.api.onUpdatePinnedRows(callbacks.pinnedRows),
      adapter.api.onUpdateSearchMode(callbacks.searchMode),
      adapter.api.onUpdateMatchRecommendation(callbacks.matchRecommendation),
      adapter.api.onUpdateTabKeyFunction(callbacks.tabKeyFunction),
      adapter.api.onUpdateTabTarget(callbacks.tabTarget),
      adapter.api.onUpdateSpaceOpenCommand(callbacks.spaceOpenCommand),
      adapter.api.onUpdateLocalAppSearch(callbacks.localAppSearch),
    ];
    await expectAdapterEventListeners(fixture);
    expect(fixture.listen).toHaveBeenCalledWith(GENERAL_EVENT, expect.any(Function));

    fixture.emitRaw({
      placeholder: "Search",
      theme: "dark",
      primaryColor: "custom",
      customColor: "#abcdef",
      autoPaste: "3s",
      autoClear: "1m",
      showRecentInSearch: true,
      recentRows: 3,
      pinnedRows: 20,
      searchMode: "list",
      showMatchRecommendation: false,
      tabKeyFunction: "target-command",
      tabTargetCommand: "open docs",
      spaceOpenCommand: true,
      localAppSearch: false,
      aiApiKey: "event-secret-must-not-leak",
    });

    expect(callbacks.placeholder).toHaveBeenCalledWith("Search");
    expect(callbacks.autoPaste).toHaveBeenCalledWith("3s");
    expect(callbacks.autoClear).toHaveBeenCalledWith("1m");
    expect(callbacks.primaryColor).toHaveBeenCalledWith({ primaryColor: "custom", customColor: "#abcdef" });
    expect(callbacks.showRecentInSearch).toHaveBeenCalledWith(true);
    expect(callbacks.recentRows).toHaveBeenCalledWith(3);
    expect(callbacks.pinnedRows).toHaveBeenCalledWith(20);
    expect(callbacks.searchMode).toHaveBeenCalledWith("list");
    expect(callbacks.matchRecommendation).toHaveBeenCalledWith(false);
    expect(callbacks.tabKeyFunction).toHaveBeenCalledWith("target-command");
    expect(callbacks.tabTarget).toHaveBeenCalledWith("open docs");
    expect(callbacks.spaceOpenCommand).toHaveBeenCalledWith(true);
    expect(callbacks.localAppSearch).toHaveBeenCalledWith(false);
    fixture.emitRaw({ recentRows: 0 });
    expect(callbacks.recentRows).toHaveBeenNthCalledWith(2, 0);
    expect(callbacks.placeholder).toHaveBeenCalledTimes(1);
    expect(callbacks.localAppSearch).toHaveBeenCalledOnce();
    expect(adapter.snapshot().generalPreferenceEvents).toEqual({
      version: 1,
      invalidPayloads: 0,
      notifiedFields: { placeholder: 1 },
    });
    expect(adapter.snapshot().inactiveEvents).toEqual([]);
    expect(adapter.capabilities().events).toMatchObject({
      onUpdateShowRecentInSearch: "limited",
      onUpdateRecentRows: "limited",
      onUpdatePinnedRows: "limited",
      onUpdateSearchMode: "limited",
      onUpdateMatchRecommendation: "limited",
      onUpdateTabKeyFunction: "limited",
      onUpdateTabTarget: "limited",
      onUpdateSpaceOpenCommand: "limited",
    });
    const delivered = [
      callbacks.placeholder.mock.calls,
      callbacks.autoPaste.mock.calls,
      callbacks.autoClear.mock.calls,
      callbacks.primaryColor.mock.calls,
      callbacks.showRecentInSearch.mock.calls,
      callbacks.recentRows.mock.calls,
      callbacks.pinnedRows.mock.calls,
      callbacks.searchMode.mock.calls,
      callbacks.matchRecommendation.mock.calls,
      callbacks.tabKeyFunction.mock.calls,
      callbacks.tabTarget.mock.calls,
      callbacks.spaceOpenCommand.mock.calls,
      callbacks.localAppSearch.mock.calls,
    ];
    expect(JSON.stringify({ delivered, snapshot: adapter.snapshot() })).not.toContain("event-secret-must-not-leak");

    stops[0]();
    expect(fixture.removalCount(GENERAL_EVENT)).toBe(0);
    for (const stop of stops.slice(1)) stop();
    expect(fixture.activeCount(GENERAL_EVENT)).toBe(1);
    expect(fixture.removalCount(GENERAL_EVENT)).toBe(0);
    expect(fixture.activeCount(APP_EVENT)).toBe(1);
    expect(fixture.removalCount(APP_EVENT)).toBe(0);
    adapter.dispose();
    expectAdapterEventListenersDisposed(fixture);
  });

  it("forwards auto-paste changes over the existing event and rejects invalid values atomically", async () => {
    const fixture = eventTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const updateAutoPaste = vi.fn();
    const updateRecentRows = vi.fn();
    const stop = adapter.api.onUpdateAutoPaste(updateAutoPaste);
    const stopRecentRows = adapter.api.onUpdateRecentRows(updateRecentRows);
    await expectAdapterEventListeners(fixture);
    expect(fixture.listen).toHaveBeenCalledWith(GENERAL_EVENT, expect.any(Function));
    expect(adapter.capabilities().events.onUpdateAutoPaste).toBe("limited");
    expect(adapter.snapshot().inactiveEvents).not.toContain("onUpdateAutoPaste");

    for (const autoPaste of ["off", "1s", "3s", "5s", "10s", "off"]) {
      fixture.emitRaw({ autoPaste });
    }
    expect(updateAutoPaste.mock.calls).toEqual([["off"], ["1s"], ["3s"], ["5s"], ["10s"], ["off"]]);

    for (const autoPaste of ["never", "0s", "2s", 3000, false, null]) {
      fixture.emitRaw({ autoPaste, recentRows: 2 });
    }
    expect(updateAutoPaste).toHaveBeenCalledTimes(6);
    expect(updateRecentRows).not.toHaveBeenCalled();
    expect(adapter.snapshot().generalPreferenceEvents.invalidPayloads).toBe(6);

    const lateListener = [...(fixture.listeners.get(GENERAL_EVENT) ?? [])][0];
    stop();
    lateListener?.({ version: 1, raw: JSON.stringify({ autoPaste: "3s", recentRows: 3 }) });
    expect(updateAutoPaste).toHaveBeenCalledTimes(6);
    expect(updateRecentRows).toHaveBeenCalledWith(3);
    stopRecentRows();
    adapter.dispose();
    lateListener?.({ version: 1, raw: JSON.stringify({ autoPaste: "3s", recentRows: 4 }) });
    expect(updateAutoPaste).toHaveBeenCalledTimes(6);
    expect(updateRecentRows).toHaveBeenCalledTimes(1);
    expectAdapterEventListenersDisposed(fixture);
  });

  it("replays the latest validated auto-paste value to late subscribers only", async () => {
    const fixture = eventTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    await expectAdapterEventListeners(fixture);

    fixture.emitRaw({ autoPaste: "1s" });
    const first = vi.fn();
    const stopFirst = adapter.api.onUpdateAutoPaste(first);
    expect(first).toHaveBeenCalledWith("1s");

    fixture.emitRaw({ autoPaste: "3s" });
    expect(first.mock.calls).toEqual([["1s"], ["3s"]]);

    const second = vi.fn();
    const stopSecond = adapter.api.onUpdateAutoPaste(second);
    expect(first.mock.calls).toEqual([["1s"], ["3s"]]);
    expect(second.mock.calls).toEqual([["3s"]]);

    fixture.emitRaw({ autoPaste: "2s", recentRows: 9 });
    const third = vi.fn();
    const stopThird = adapter.api.onUpdateAutoPaste(third);
    expect(third.mock.calls).toEqual([["3s"]]);
    expect(first.mock.calls).toEqual([["1s"], ["3s"]]);
    expect(second.mock.calls).toEqual([["3s"]]);
    expect(adapter.snapshot().generalPreferenceEvents.invalidPayloads).toBe(1);

    stopFirst();
    stopSecond();
    stopThird();
    adapter.dispose();
    expectAdapterEventListenersDisposed(fixture);
  });

  it("rejects malformed known values and proxy envelopes without delivering any field", async () => {
    expect(isGeneralPreferenceValue("__proto__", "dark")).toBe(false);
    expect(isGeneralPreferenceValue("constructor", "dark")).toBe(false);
    const fixture = eventTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const recent = vi.fn();
    const searchMode = vi.fn();
    const showRecent = vi.fn();
    const tabTarget = vi.fn();
    adapter.api.onUpdateRecentRows(recent);
    adapter.api.onUpdateSearchMode(searchMode);
    adapter.api.onUpdateShowRecentInSearch(showRecent);
    adapter.api.onUpdateTabTarget(tabTarget);
    await expectAdapterEventListeners(fixture);

    for (const invalid of [
      { searchMode: "grid" },
      { showRecentInSearch: "true" },
      { recentRows: 1.5 },
      { recentRows: -1 },
      { pinnedRows: 21 },
      { tabKeyFunction: "space" },
      { tabTargetCommand: "line\nbreak" },
      { localAppSearch: "false" },
    ]) fixture.emitRaw(invalid);
    fixture.emit(GENERAL_EVENT, new Proxy({ version: 1, raw: "{}" }, { ownKeys: () => { throw new Error("fixture proxy"); } }));
    fixture.emitRaw({ unrelatedSecret: "ignored-secret" });

    expect(recent).not.toHaveBeenCalled();
    expect(searchMode).not.toHaveBeenCalled();
    expect(showRecent).not.toHaveBeenCalled();
    expect(tabTarget).not.toHaveBeenCalled();
    expect(adapter.snapshot().generalPreferenceEvents).toMatchObject({ invalidPayloads: 9 });
    expect(JSON.stringify(adapter.snapshot())).not.toContain("ignored-secret");
    adapter.dispose();
    expectAdapterEventListenersDisposed(fixture);
  });

  it("retains the 64-callback cap and listener cleanup after the last subscriber", async () => {
    const fixture = eventTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const stops = Array.from({ length: 64 }, () => adapter.api.onUpdatePinnedRows(vi.fn()));
    await expectAdapterEventListeners(fixture);
    let overflow: unknown;
    try {
      adapter.api.onUpdatePinnedRows(vi.fn());
    } catch (error) {
      overflow = error;
    }
    expect(overflow).toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" });
    for (const stop of stops) stop();
    expect(fixture.activeCount(GENERAL_EVENT)).toBe(1);
    expect(fixture.removalCount(GENERAL_EVENT)).toBe(0);
    expect(fixture.activeCount(APP_EVENT)).toBe(1);
    expect(fixture.removalCount(APP_EVENT)).toBe(0);
    adapter.dispose();
    expectAdapterEventListenersDisposed(fixture);
  });

  it("retains the separate 64-app-search observer cap and error label", async () => {
    const fixture = eventTransport();
    const events = createRendererGeneralPreferenceEvents(fixture.transport);
    const stops = Array.from({ length: 64 }, () => events.observeLocalAppSearch(vi.fn()));
    await vi.waitFor(() => expect(fixture.activeCount(GENERAL_EVENT)).toBe(1));

    let overflow: unknown;
    try {
      events.observeLocalAppSearch(vi.fn());
    } catch (error) {
      overflow = error;
    }
    expect(overflow).toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
      message: "onUpdateLocalAppSearch: callback limit.",
    });

    for (const stop of stops) stop();
    expect(fixture.activeCount(GENERAL_EVENT)).toBe(0);
    expect(fixture.removalCount(GENERAL_EVENT)).toBe(1);
    events.dispose();
  });
});
