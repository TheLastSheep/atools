import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS, createStartupReadModel } from "../../packages/ztools-renderer/src/startupReadModel";
import type {
  AppMutationRequest,
  RendererAppStateValues,
} from "../../packages/ztools-renderer/src/appStateProtocol";
import type {
  RendererHostCommand,
  RendererHostListener,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

type NativeCall = { command: RendererHostCommand; args?: Record<string, unknown> };

function appStatePayload(
  revision: number,
  changed: Array<"command-history" | "pinned-commands">,
  values: RendererAppStateValues,
) {
  return { version: 1, revision, values, changed };
}

function settingsPayload(overrides: Record<string, string | null>) {
  const settings = Object.fromEntries(
    [...NAMESPACED_READ_KEYS].map((key) => [
      `ztools-renderer:${key}`,
      overrides[`ztools-renderer:${key}`] ?? null,
    ]),
  );
  return { version: 1, settings: { "settings-general": null, ...settings } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("ZTools renderer app-state integration", () => {
  for (const lateBatch of ["success", "failure"] as const) {
    it(`keeps launch-reply state after the pending startup batch later ${lateBatch === "success" ? "succeeds" : "fails"}`, async () => {
      const staleBatch = deferred<unknown>();
      const calls: NativeCall[] = [];
      const unlisten = vi.fn();
      const freshHistory = JSON.stringify([{
        path: "/Applications/Example.app",
        name: "Example",
        type: "direct",
        subType: "app",
        lastUsed: 200,
        useCount: 2,
      }]);
      const freshPins = JSON.stringify([{
        path: "/Applications/Example.app",
        name: "Pinned Example",
        type: "direct",
        subType: "app",
      }]);
      const staleHistory = JSON.stringify([{ path: "/old", name: "Old", type: "direct", subType: "app" }]);
      const stalePins = JSON.stringify([{ path: "/old-pin", name: "Old Pin", type: "direct", subType: "app" }]);
      const transport: ZToolsRendererTransport = {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "get_ztools_renderer_settings") return staleBatch.promise;
          if (command === "list_launcher_apps") {
            return [{ name: "Example", path: "/Applications/Example.app" }];
          }
          if (command === "launch_renderer_app") {
            return appStatePayload(1, ["command-history", "pinned-commands"], {
              "command-history": freshHistory,
              "pinned-commands": freshPins,
            });
          }
          throw new Error(`unexpected route: ${command}`);
        },
        async listen(event, handler) {
          if (event === "atools://renderer-general-settings"
            || event === "atools://renderer-local-shortcuts"
            || event === "atools://renderer-apps-changed") return () => undefined;
          expect(event).toBe("atools://renderer-app-state");
          return unlisten;
        },
      };
      const adapter = createZtoolsRendererHostAdapter({ transport });
      const pendingHistory = adapter.api.dbGet("command-history");
      const pendingPins = adapter.api.dbGet("pinned-commands");
      await settlePromises();
      expect(calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(1);

      let callbackRead: Promise<unknown> | undefined;
      adapter.api.onHistoryChanged(() => {
        callbackRead = adapter.api.dbGet("command-history");
      });
      await settlePromises();
      await expect(adapter.api.launch({ path: "/Applications/Example.app", type: "app" }))
        .resolves.toMatchObject({ revision: 1 });
      await expect(callbackRead).resolves.toEqual(JSON.parse(freshHistory));

      if (lateBatch === "success") {
        staleBatch.resolve(settingsPayload({
          "ztools-renderer:command-history": staleHistory,
          "ztools-renderer:pinned-commands": stalePins,
        }));
      } else {
        staleBatch.reject(new Error("late startup settings failure"));
      }
      if (lateBatch === "success") {
        await expect(pendingHistory).resolves.toEqual(JSON.parse(freshHistory));
        await expect(pendingPins).resolves.toEqual(JSON.parse(freshPins));
      } else {
        await expect(pendingHistory).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
        await expect(pendingPins).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
      }
      await expect(adapter.api.dbGet("command-history")).resolves.toEqual(JSON.parse(freshHistory));
      await expect(adapter.api.dbGet("pinned-commands")).resolves.toEqual(JSON.parse(freshPins));
      expect(adapter.snapshot().settingsSnapshot.requests).toBe(1);
      expect(calls.filter((call) => call.command === "launch_renderer_app")).toHaveLength(1);
      adapter.dispose();
      expect(unlisten).toHaveBeenCalledOnce();
    });
  }

  it.each(["launch", "reveal"] as const)(
    "uses the installed-app catalog before waiting for local shortcuts when direct %s targets a known app",
    async (operation) => {
      const pendingStartupBatch = deferred<unknown>();
      const startupReadStarted = deferred<void>();
      const calls: NativeCall[] = [];
      const listeningEvents: string[] = [];
      const unlistens: Array<ReturnType<typeof vi.fn>> = [];
      const expectedApp = { path: "/Applications/Example.app", name: "Example" };
      const transport: ZToolsRendererTransport = {
        async invoke(command, args) {
          calls.push({ command, args });
          if (command === "get_ztools_renderer_settings") {
            startupReadStarted.resolve();
            return pendingStartupBatch.promise;
          }
          if (command === "list_launcher_apps") return [expectedApp];
          if (command === "launch_renderer_app") return appStatePayload(1, [], {
            "command-history": null,
            "pinned-commands": null,
          });
          if (command === "call_agent_tool") return null;
          throw new Error(`unexpected route: ${command}`);
        },
        async listen(event) {
          listeningEvents.push(event);
          if (event === "atools://renderer-general-settings"
            || event === "atools://renderer-local-shortcuts"
            || event === "atools://renderer-apps-changed"
            || event === "atools://renderer-app-state") {
            const unlisten = vi.fn();
            unlistens.push(unlisten);
            return unlisten;
          }
          throw new Error(`unexpected event: ${event}`);
        },
      };
      const adapter = createZtoolsRendererHostAdapter({ transport });
      const pendingStartupRead = adapter.api.dbGet("command-history");
      await startupReadStarted.promise;

      const pendingOperation = operation === "launch"
        ? adapter.api.launch({ path: expectedApp.path, type: "direct" })
        : adapter.api.revealInFinder(expectedApp.path);
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
      const appOperationStarted = operation === "launch"
        ? calls.some((call) => call.command === "launch_renderer_app")
        : calls.some((call) => call.command === "call_agent_tool");

      pendingStartupBatch.resolve(settingsPayload({}));
      await expect(pendingStartupRead).resolves.toBeNull();
      await pendingOperation;
      expect(appOperationStarted).toBe(true);
      expect(calls.filter((call) => call.command === "get_ztools_renderer_settings")).toHaveLength(1);
      adapter.dispose();
      expect(listeningEvents).toEqual(expect.arrayContaining([
        "atools://renderer-general-settings",
        "atools://renderer-local-shortcuts",
        "atools://renderer-apps-changed",
      ]));
      for (const unlisten of unlistens) expect(unlisten).toHaveBeenCalledOnce();
    },
  );

  it("rejects malformed app-state atomically without replacing either cached domain", async () => {
    const oldHistory = JSON.stringify([{ path: "/old", name: "Old", type: "direct", subType: "app" }]);
    const oldPins = JSON.stringify([{ path: "/old-pin", name: "Old Pin", type: "direct", subType: "app" }]);
    const getSetting = vi.fn(async (key: string) => ({
      "ztools-renderer:command-history": oldHistory,
      "ztools-renderer:pinned-commands": oldPins,
    }[key] ?? null));
    const readModel = createStartupReadModel(getSetting, async () => {
      throw new Error("unexpected unsupported read");
    });
    await Promise.all([
      readModel.dbGet("command-history"),
      readModel.dbGet("pinned-commands"),
    ]);

    const acceptedHistory = JSON.stringify([{ path: "/fresh", name: "Fresh", type: "direct", subType: "app" }]);
    const acceptedPins = JSON.stringify([{ path: "/fresh-pin", name: "Fresh Pin", type: "direct", subType: "app" }]);
    const accepted: Record<"command-history" | "pinned-commands", string | null> = {
      "command-history": acceptedHistory,
      "pinned-commands": acceptedPins,
    };
    readModel.acceptAppState(accepted);

    for (const malformedPins of ["{not-json", "[null]"]) {
      expect(() => readModel.acceptAppState({
        "command-history": JSON.stringify([{ path: "/partial", name: "Partial" }]),
        "pinned-commands": malformedPins,
      })).toThrow();
      await expect(readModel.dbGet("command-history")).resolves.toEqual(JSON.parse(acceptedHistory));
      await expect(readModel.dbGet("pinned-commands")).resolves.toEqual(JSON.parse(acceptedPins));
    }
    expect(getSetting).toHaveBeenCalledTimes(2);
    readModel.dispose();
  });

  it("deduplicates same-revision event and reply, runs app APIs as one RPC each, and disposes pending work", async () => {
    const calls: NativeCall[] = [];
    const requests: AppMutationRequest[] = [];
    const unlisten = vi.fn();
    const pendingNative = deferred<unknown>();
    let eventListener: RendererHostListener | undefined;
    let revision = 0;
    let pins: Array<{ path: string; name: string; type: string; subType: string }> = [];
    const transport: ZToolsRendererTransport = {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command !== "mutate_renderer_app_state") throw new Error(`unexpected route: ${command}`);
        const request = args?.request as AppMutationRequest;
        requests.push(request);
        if (requests.length === 5) return pendingNative.promise;
        if (request.operation === "pin") {
          pins.push({ ...request.app, type: "direct", subType: "app" });
        } else if (request.operation === "unpin") {
          pins = pins.filter((pin) => pin.path !== request.path || (request.name !== undefined && pin.name !== request.name));
        } else if (request.operation === "reorder_pins") {
          pins = request.apps.map((app) => ({ ...app, type: "direct", subType: "app" }));
        } else if (request.operation === "clear_pins") {
          pins = [];
        }
        revision += 1;
        const payload = appStatePayload(revision, ["pinned-commands"], {
          "command-history": null,
          "pinned-commands": JSON.stringify(pins),
        });
        eventListener?.(payload);
        return payload;
      },
      async listen(event, handler) {
        if (event === "atools://renderer-general-settings") return () => undefined;
        expect(event).toBe("atools://renderer-app-state");
        eventListener = handler;
        return unlisten;
      },
    };
    const adapter = createZtoolsRendererHostAdapter({ transport });
    const observedPins: unknown[] = [];
    adapter.api.onPinnedChanged(() => {
      void adapter.api.dbGet("pinned-commands").then((value) => observedPins.push(value));
    });
    await settlePromises();

    await adapter.api.pinApp({ type: "app", path: "/app", name: "A" });
    await adapter.api.unpinApp("/app", undefined, "A");
    await adapter.api.updatePinnedOrder([
      { type: "app", path: "/app", name: "B" },
      { type: "direct", subType: "app", path: "/app", name: "A" },
    ]);
    await adapter.api.dbPut("pinned-commands", []);
    await settlePromises();

    expect(requests).toEqual([
      { operation: "pin", app: { path: "/app", name: "A" } },
      { operation: "unpin", path: "/app", name: "A" },
      { operation: "reorder_pins", apps: [{ path: "/app", name: "B" }, { path: "/app", name: "A" }] },
      { operation: "clear_pins" },
    ]);
    expect(calls.map((call) => call.command)).toEqual(Array(4).fill("mutate_renderer_app_state"));
    await expect(adapter.api.dbGet("pinned-commands")).resolves.toEqual([]);
    expect(observedPins).toEqual([
      [{ path: "/app", name: "A", type: "direct", subType: "app" }],
      [],
      [
        { path: "/app", name: "B", type: "direct", subType: "app" },
        { path: "/app", name: "A", type: "direct", subType: "app" },
      ],
      [],
    ]);
    expect(adapter.snapshot().appState).toMatchObject({
      acceptedEvents: 4,
      acceptedReplies: 0,
      stalePayloads: 4,
    });

    const lateWrite = adapter.api.pinApp({ type: "app", path: "/app", name: "Late" });
    await settlePromises();
    adapter.dispose();
    await expect(lateWrite).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    pendingNative.resolve(appStatePayload(5, ["pinned-commands"], {
      "command-history": null,
      "pinned-commands": JSON.stringify([{ path: "/app", name: "Late", type: "direct", subType: "app" }]),
    }));
    await settlePromises();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(observedPins).toHaveLength(4);
    expect(adapter.snapshot()).toMatchObject({
      disposed: true,
      outstandingNativeCalls: 0,
      appState: { disposed: true, queuedMutations: 0 },
    });
    expect(calls).toHaveLength(5);
  });
});
