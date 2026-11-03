import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type {
  RendererHostListener,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const LOCAL_EVENT = "atools://renderer-local-shortcuts";
const EMPTY_APP_STATE = {
  version: 1,
  revision: 1,
  values: { "command-history": null, "pinned-commands": null },
  changed: [],
};

interface Shortcut {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder" | "app";
  addedAt: number;
}

function settingsResponse(rows: Shortcut[]): unknown {
  const settings: Record<string, string | null> = Object.fromEntries(
    [...NAMESPACED_READ_KEYS].map((key) => [`ztools-renderer:${key}`, null]),
  );
  settings["settings-general"] = JSON.stringify({ localAppSearch: true });
  settings["ztools-renderer:local-shortcuts"] = JSON.stringify(rows);
  return { version: 1, settings };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createFixture(options: {
  rows(): Shortcut[];
  readSettings?: () => Promise<unknown> | unknown;
}): {
  adapter: ReturnType<typeof createZtoolsRendererHostAdapter>;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  emit(event: string, payload: unknown): void;
  listenerCount(event: string): number;
  listenCalls(event: string): number;
} {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<RendererHostListener>>();
  const listenCounts = new Map<string, number>();
  const transport: ZToolsRendererTransport = {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_ztools_renderer_settings") {
        return options.readSettings ? options.readSettings() : settingsResponse(options.rows());
      }
      if (command === "list_launcher_apps") return [{ path: "/Applications/Reader.app", name: "Reader" }];
      if (command === "launch_renderer_app") return EMPTY_APP_STATE;
      if (command === "reveal_renderer_target") return { success: true };
      throw new Error(`Unexpected renderer command: ${command}`);
    },
    async listen(event, listener) {
      listenCounts.set(event, (listenCounts.get(event) ?? 0) + 1);
      const handlers = listeners.get(event) ?? new Set<RendererHostListener>();
      handlers.add(listener);
      listeners.set(event, handlers);
      return () => handlers.delete(listener);
    },
  };
  return {
    adapter: createZtoolsRendererHostAdapter({ transport }),
    calls,
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    listenCalls(event) {
      return listenCounts.get(event) ?? 0;
    },
  };
}

async function prepareMainSettings(adapter: ReturnType<typeof createZtoolsRendererHostAdapter>): Promise<void> {
  await adapter.api.getApps();
}

describe("Main local-shortcut routing and cache invalidation", () => {
  it("routes registered local shortcuts through launch/reveal and keeps unknown paths behind existing app allowlists", async () => {
    const rows: Shortcut[] = [{
      id: "local-file", name: "Notes", path: "/tmp/notes.txt", type: "file", addedAt: 1,
    }];
    const fixture = createFixture({ rows: () => rows });
    await prepareMainSettings(fixture.adapter);

    const appReadsBeforeExplicitLocal = fixture.calls.filter((call) => call.command === "list_launcher_apps").length;
    await fixture.adapter.api.launch({
      path: rows[0].path, name: rows[0].name, type: "direct", subType: "local-shortcut",
    });
    expect(fixture.calls.filter((call) => call.command === "list_launcher_apps")).toHaveLength(appReadsBeforeExplicitLocal);
    await expect(fixture.adapter.api.launch({ path: rows[0].path, name: rows[0].name, type: "app" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });

    await fixture.adapter.api.launch({ path: rows[0].path, name: rows[0].name, type: "direct" });
    await fixture.adapter.api.revealInFinder(rows[0].path);
    await expect(fixture.adapter.api.launch({
      path: "/tmp/unregistered.txt", name: "Unregistered", type: "direct", subType: "local-shortcut",
    })).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });

    expect(fixture.calls.filter((call) => call.command === "launch_renderer_app").map((call) => call.args)).toEqual([
      { target: { path: rows[0].path, name: rows[0].name, subType: "local-shortcut" } },
      { target: { path: rows[0].path, name: rows[0].name, subType: "local-shortcut" } },
    ]);
    expect(fixture.calls.filter((call) => call.command === "reveal_renderer_target").map((call) => call.args)).toEqual([
      { target: { path: rows[0].path, name: rows[0].name, subType: "local-shortcut" } },
    ]);
    expect(fixture.calls.filter((call) => call.command === "call_agent_tool")).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(1);
    expect(fixture.listenCalls(LOCAL_EVENT)).toBe(1);
    fixture.adapter.dispose();
  });

  it("invalidates only on validated newer events before callback reads and ignores invalid or stale notifications", async () => {
    const first: Shortcut[] = [{ id: "one", name: "One", path: "/tmp/one", type: "file", addedAt: 1 }];
    let rows = first;
    const fixture = createFixture({ rows: () => rows });
    await prepareMainSettings(fixture.adapter);
    const callbackRows: Shortcut[][] = [];
    let callbackRead: Promise<Shortcut[]> | undefined;
    fixture.adapter.api.onLocalShortcutsChanged(async () => {
      callbackRead = fixture.adapter.api.localShortcuts.getAll().then((value) => {
        callbackRows.push(value);
        return value;
      });
    });
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(1);
    await expect(fixture.adapter.api.localShortcuts.getAll()).resolves.toEqual(first);
    const settingsReadsBeforeEvents = fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings").length;

    rows = [{ id: "two", name: "Two", path: "/tmp/two", type: "folder", addedAt: 2 }];
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 4, extra: true });
    expect(callbackRows).toHaveLength(0);
    await expect(fixture.adapter.api.localShortcuts.getAll()).resolves.toEqual(first);
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(settingsReadsBeforeEvents);

    fixture.emit(LOCAL_EVENT, { version: 1, revision: 4 });
    expect(callbackRead).toBeDefined();
    await expect(callbackRead).resolves.toEqual(rows);
    await expect(fixture.adapter.api.localShortcuts.getAll()).resolves.toEqual(rows);
    const readsAfterAcceptedEvent = fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings").length;

    fixture.emit(LOCAL_EVENT, { version: 1, revision: 4 });
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 3 });
    fixture.emit(LOCAL_EVENT, { version: 0, revision: 5 });
    expect(callbackRows).toHaveLength(1);
    await expect(fixture.adapter.api.localShortcuts.getAll()).resolves.toEqual(rows);
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(readsAfterAcceptedEvent);
    fixture.adapter.dispose();
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(0);
  });

  it("retries a settings read invalidated while in flight so late startup data cannot roll back shortcuts", async () => {
    const initial: Shortcut[] = [{ id: "one", name: "One", path: "/tmp/one", type: "file", addedAt: 1 }];
    const intermediate: Shortcut[] = [{ id: "two", name: "Two", path: "/tmp/two", type: "folder", addedAt: 2 }];
    const latest: Shortcut[] = [{ id: "three", name: "Three", path: "/tmp/three", type: "app", addedAt: 3 }];
    let rows = initial;
    let pendingSettings = deferred<unknown>();
    const pendingSettingsStarted = deferred<void>();
    let deferNextRead = false;
    const fixture = createFixture({
      rows: () => rows,
      readSettings: () => {
        if (deferNextRead) {
          deferNextRead = false;
          pendingSettingsStarted.resolve();
          return pendingSettings.promise;
        }
        return settingsResponse(rows);
      },
    });
    await prepareMainSettings(fixture.adapter);
    fixture.adapter.api.onLocalShortcutsChanged(() => undefined);

    fixture.emit(LOCAL_EVENT, { version: 1, revision: 1 });
    rows = intermediate;
    deferNextRead = true;
    const pendingRead = fixture.adapter.api.localShortcuts.getAll();
    await pendingSettingsStarted.promise;
    rows = latest;
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 2 });
    pendingSettings.resolve(settingsResponse(intermediate));

    await expect(pendingRead).resolves.toEqual(latest);
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(3);
    fixture.adapter.dispose();
  });

  it("replays an early change to the original store after its late listener registration", async () => {
    let rows: Shortcut[] = [{ id: "old", name: "Old", path: "/tmp/old", type: "file", addedAt: 1 }];
    const fixture = createFixture({ rows: () => rows });
    await prepareMainSettings(fixture.adapter);
    const otherStartupReads = deferred<void>();
    const initialLocalRead = deferred<void>();
    let originalCommands: string[] = [];
    let reloads = 0;
    let reload: Promise<Shortcut[]> = Promise.resolve([]);
    let listenCallsDuringLocalRead = 0;

    async function initializePinnedMainStore(): Promise<void> {
      const shortcuts = await fixture.adapter.api.localShortcuts.getAll();
      originalCommands = shortcuts.map((shortcut) => shortcut.path);
      listenCallsDuringLocalRead = fixture.listenCalls(LOCAL_EVENT);
      initialLocalRead.resolve();
      await otherStartupReads.promise;
      fixture.adapter.api.onLocalShortcutsChanged(() => {
        reloads += 1;
        reload = fixture.adapter.api.localShortcuts.getAll().then((latest) => {
          originalCommands = latest.map((shortcut) => shortcut.path);
          return latest;
        });
      });
    }

    const initialization = initializePinnedMainStore();
    await initialLocalRead.promise;
    rows = [{ id: "new", name: "New", path: "/tmp/new", type: "folder", addedAt: 2 }];
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 1 });
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 2, extra: true });
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 0 });
    expect(fixture.adapter.snapshot().localShortcutEvents).toMatchObject({
      latestRevision: 1,
      replayPending: true,
      invalidEvents: 1,
      staleEvents: 1,
    });
    otherStartupReads.resolve();
    await initialization;
    await reload;

    expect(originalCommands).toEqual(["/tmp/new"]);
    expect(reloads).toBe(1);
    expect(listenCallsDuringLocalRead).toBe(1);
    expect(fixture.listenCalls(LOCAL_EVENT)).toBe(1);
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(1);
    expect(fixture.calls.filter((call) => call.command === "list_launcher_apps")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(2);
    fixture.adapter.dispose();
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(0);
  });

  it("starts the local event monitor before any setting warms the shared snapshot", async () => {
    let rows: Shortcut[] = [{ id: "old", name: "Old", path: "/tmp/old", type: "file", addedAt: 1 }];
    const fixture = createFixture({ rows: () => rows });
    fixture.adapter.api.onUpdateLocalAppSearch(() => undefined);
    await expect(fixture.adapter.api.dbGet("settings-general")).resolves.toMatchObject({ localAppSearch: true });
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(1);
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(1);

    rows = [{ id: "new", name: "New", path: "/tmp/new", type: "folder", addedAt: 2 }];
    fixture.emit(LOCAL_EVENT, { version: 1, revision: 1 });
    await expect(fixture.adapter.api.localShortcuts.getAll()).resolves.toEqual(rows);
    expect(fixture.calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(2);
    fixture.adapter.dispose();
  });

  it("keeps listener bounds and callback error isolation with the shared monitor", async () => {
    const rows: Shortcut[] = [{ id: "one", name: "One", path: "/tmp/one", type: "file", addedAt: 1 }];
    const fixture = createFixture({ rows: () => rows });
    await prepareMainSettings(fixture.adapter);
    const failedCallback = vi.fn(() => { throw new Error("consumer failure"); });
    const healthyCallback = vi.fn();
    const unsubscribe = [
      fixture.adapter.api.onLocalShortcutsChanged(failedCallback),
      fixture.adapter.api.onLocalShortcutsChanged(healthyCallback),
    ];
    for (let index = 2; index < 64; index += 1) {
      unsubscribe.push(fixture.adapter.api.onLocalShortcutsChanged(() => undefined));
    }
    expect(() => fixture.adapter.api.onLocalShortcutsChanged(() => undefined)).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
    );
    expect(fixture.listenCalls(LOCAL_EVENT)).toBe(1);

    fixture.emit(LOCAL_EVENT, { version: 1, revision: 1 });
    expect(failedCallback).toHaveBeenCalledOnce();
    expect(healthyCallback).toHaveBeenCalledOnce();
    expect(fixture.adapter.snapshot().localShortcutEvents).toMatchObject({
      subscribers: 64,
      callbackErrors: 1,
    });

    for (const unlisten of unsubscribe) unlisten();
    expect(fixture.adapter.snapshot().localShortcutEvents.subscribers).toBe(0);
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(1);
    fixture.adapter.dispose();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(fixture.listenerCount(LOCAL_EVENT)).toBe(0);
    expect(fixture.adapter.snapshot().localShortcutEvents).toMatchObject({
      latestRevision: null,
      replayPending: false,
    });
  });
});
