import { beforeEach, expect, it, vi } from "vitest";
import { createLauncherPluginWindowController } from "../../src/lib/launcherPluginWindowController";
import type { FeatureAction } from "../../src/lib/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

function action(code: string, pluginId = `owner:${code}`): FeatureAction {
  return {
    plugin_id: pluginId,
    plugin_name: "Test Plugin",
    feature_code: code,
    main_url: "index.html",
    plugin_path: "/plugins/test",
    expand_height: 400,
    payload: { exact: ["payload", code] },
    entry_type: "over",
    auto_detach: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options: {
  detached?: boolean;
  active?: FeatureAction | null;
  open?: (value: FeatureAction, isCurrent?: () => boolean) => Promise<boolean>;
  claim?: (handoffId: string) => Promise<FeatureAction>;
} = {}) {
  let generation = 0;
  let activePlugin = options.active ?? null;
  const activationErrors: string[] = [];
  const openPluginDetachAction = vi.fn(options.open ?? (async () => true));
  const claimPluginDetachAction = vi.fn(options.claim ?? (async () => action("claimed")));
  const onReturnToSearch = vi.fn(async () => { activePlugin = null; });
  const lifecycle = {
    beginActivation: () => ({ generation: ++generation, mutation: 0 }),
    start: vi.fn(async () => undefined),
    isCurrent: (token: { generation: number }) => token.generation === generation,
  };
  const ports = {
    isDetachWindow: options.detached ?? false,
    hasTauriRuntime: () => true,
    activePlugin: () => activePlugin,
    setActivePlugin: (value: FeatureAction | null) => { activePlugin = value; },
    setActivationError: (message: string) => { activationErrors.push(message); },
    clearActivationError: vi.fn(),
    lifecycle,
    onReturnToSearch,
    openPluginDetachAction,
    claimPluginDetachAction,
    activateFeature: vi.fn(async () => undefined),
    resizePalette: vi.fn(async () => undefined),
    onEscape: vi.fn(),
    onSettingsRedirect: vi.fn(),
    onReady: vi.fn(),
    onLoadError: vi.fn(),
    desktopSmokeEnabled: () => false,
    smokeActions: () => [],
    smokeIndex: () => 0,
    smokeExternalPlan: () => false,
    onSmokeRender: vi.fn(),
  } as unknown as Parameters<typeof createLauncherPluginWindowController>[0];
  return {
    controller: createLauncherPluginWindowController(ports),
    ports,
    active: () => activePlugin,
    activationErrors,
    openPluginDetachAction,
    claimPluginDetachAction,
    onReturnToSearch,
    lifecycle,
  };
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "activate_feature") return action(String(args.code), String(args.expectedPluginId ?? `owner:${args.code}`));
    if (command === "search_features") return [];
    return undefined;
  });
  window.location.hash = "#/";
});

it("manual detach sends the exact action and returns only after a successful open", async () => {
  const current = action("manual");
  const f = harness({ active: current });
  await f.controller.onPluginDetachAction();
  expect(f.openPluginDetachAction).toHaveBeenCalledWith(current, expect.any(Function));
  expect(f.onReturnToSearch).toHaveBeenCalledOnce();
  expect(f.active()).toBeNull();
  expect(f.activationErrors).toEqual([]);
});

it("manual detach failure keeps the active panel and exposes a retryable error", async () => {
  const current = action("manual-fail");
  const f = harness({ active: current, open: async () => { throw new Error("window unavailable"); } });
  await f.controller.onPluginDetachAction();
  expect(f.active()).toBe(current);
  expect(f.onReturnToSearch).not.toHaveBeenCalled();
  expect(f.activationErrors.at(-1)).toContain("请重试");
});

it("does not let an older successful manual open return a newer plugin to search", async () => {
  const opened = deferred<boolean>();
  const first = action("first"), second = action("second");
  const f = harness({ active: first, open: () => opened.promise });
  const request = f.controller.onPluginDetachAction();
  await vi.waitFor(() => expect(f.openPluginDetachAction).toHaveBeenCalledOnce());
  const setter = f.ports as unknown as { setActivePlugin: (value: FeatureAction | null) => void };
  setter.setActivePlugin(second);
  opened.resolve(true);
  await request;
  expect(f.active()).toBe(second);
  expect(f.onReturnToSearch).not.toHaveBeenCalled();
});

it("claims a handoff before legacy fields and never activates a guessed feature", async () => {
  window.location.hash = "#/plugin-detach?handoff=one-shot&feature_code=legacy&plugin_id=old";
  const claimed = action("claimed", "owner:claimed");
  const f = harness({ detached: true, claim: async () => claimed });
  await Promise.all([f.controller.initializeDetachedPluginWindow(), f.controller.initializeDetachedPluginWindow()]);
  expect(f.claimPluginDetachAction).toHaveBeenCalledOnce();
  expect(f.claimPluginDetachAction).toHaveBeenCalledWith("one-shot");
  expect(f.active()).toBe(claimed);
  expect(tauri.invoke).not.toHaveBeenCalledWith("activate_feature", expect.anything());
  expect(f.openPluginDetachAction).not.toHaveBeenCalled();
});

it("shows a handoff claim error without falling back to legacy activation", async () => {
  window.location.hash = "#/plugin-detach?handoff=expired&feature_code=must-not-run";
  const f = harness({ detached: true, claim: async () => { throw new Error("expired handoff"); } });
  await f.controller.initializeDetachedPluginWindow();
  expect(f.active()).toBeNull();
  expect(f.activationErrors.at(-1)).toContain("无法认领");
  expect(tauri.invoke).not.toHaveBeenCalledWith("activate_feature", expect.anything());
});

it("continues to support old feature_code/plugin_id detached routes", async () => {
  window.location.hash = "#/plugin-detach?feature_code=legacy&plugin_id=owner%3Alegacy";
  const f = harness({ detached: true });
  await f.controller.initializeDetachedPluginWindow();
  expect(tauri.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "legacy",
    payload: null,
    expectedPluginId: "owner:legacy",
  });
  expect(f.active()).toMatchObject({ feature_code: "legacy", plugin_id: "owner:legacy" });
});

it("never opens or returns a plugin from a detached route", async () => {
  const current = action("already-detached");
  const f = harness({ detached: true, active: current });
  await f.controller.onPluginDetachAction();
  expect(f.openPluginDetachAction).not.toHaveBeenCalled();
  expect(f.onReturnToSearch).not.toHaveBeenCalled();
});
