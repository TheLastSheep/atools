import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAppUpdaterController,
  type AppUpdateMetadata,
  type AppUpdateProgress,
  type AppUpdaterDependencies,
  type AppUpdaterState,
} from "../../src/lib/appUpdater";
import AppUpdaterHarness from "./AppUpdaterHarness.svelte";

afterEach(cleanup);

const update: AppUpdateMetadata = {
  candidateId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  currentVersion: "3.0.0",
  version: "3.0.1",
  date: "2026-07-15T00:00:00Z",
  body: "Security and reliability fixes",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function fakeDependencies(options: {
  check?: AppUpdateMetadata | null | Promise<AppUpdateMetadata | null>;
  installError?: unknown;
  desktop?: boolean;
} = {}) {
  let timerHandler: (() => void) | undefined;
  let progressHandler: ((event: { payload: unknown }) => void) | undefined;
  const unlisten = vi.fn();
  const invoke = vi.fn(async (command: string) => {
    if (command === "check_app_update") {
      return await ("check" in options ? options.check : update);
    }
    if (command === "install_app_update" && options.installError) {
      throw options.installError;
    }
    return undefined;
  });
  const deps: AppUpdaterDependencies = {
    invoke,
    listen: vi.fn(async (_event, handler) => {
      progressHandler = handler;
      return unlisten;
    }),
    setTimer: vi.fn((handler, delay) => {
      timerHandler = handler;
      return delay;
    }),
    clearTimer: vi.fn(),
    now: () => new Date("2026-07-14T12:00:00Z"),
    isDesktop: () => options.desktop ?? true,
  };
  return {
    deps,
    invoke,
    unlisten,
    fireTimer: () => timerHandler?.(),
    emitProgress: (payload: AppUpdateProgress) => progressHandler?.({ payload }),
  };
}

describe("app updater controller", () => {
  it("checks once for concurrent callers and exposes an available update", async () => {
    const pending = deferred<AppUpdateMetadata | null>();
    const fake = fakeDependencies({ check: pending.promise });
    const controller = createAppUpdaterController(fake.deps);

    const first = controller.check("startup");
    const second = controller.check("manual");
    expect(first).toBe(second);
    expect(controller.snapshot().phase).toBe("checking");

    pending.resolve(update);
    await first;

    expect(fake.invoke).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().phase).toBe("available");
    expect(controller.snapshot().update?.version).toBe("3.0.1");
    expect(controller.snapshot().promptVisible).toBe(true);
  });

  it("reports an up-to-date result without showing the prompt", async () => {
    const fake = fakeDependencies({ check: null });
    const controller = createAppUpdaterController(fake.deps);

    await controller.check("manual");

    expect(controller.snapshot()).toMatchObject({
      phase: "up-to-date",
      update: null,
      checkedAt: "2026-07-14T12:00:00.000Z",
      promptVisible: false,
    });
  });

  it("registers the native startup without a second JS timer", async () => {
    const fake = fakeDependencies();
    const controller = createAppUpdaterController(fake.deps);
    const cancel = controller.scheduleStartupCheck();
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledWith("startup_app_update"));
    expect(fake.deps.setTimer).not.toHaveBeenCalled();
    cancel();
  });

  it("rejects malformed candidate metadata before presenting a confirmation", async () => {
    const fake = fakeDependencies({ check: { ...update, candidateId: "invalid" } });
    const controller = createAppUpdaterController(fake.deps);
    await expect(controller.check("manual")).rejects.toMatchObject({ code: "invalid_response" });
    expect(controller.snapshot().update).toBeNull();
  });

  it("keeps a later status event when the startup response arrives late", async () => {
    const pending = deferred<unknown>();
    let listener: ((event: { payload: unknown }) => void) | undefined;
    const fake = fakeDependencies();
    fake.deps.listen = vi.fn(async (_event, handler) => { listener = handler; return () => undefined; });
    fake.deps.invoke = vi.fn(() => pending.promise);
    const controller = createAppUpdaterController(fake.deps);
    const cancel = controller.scheduleStartupCheck();
    await vi.waitFor(() => expect(listener).toBeDefined());
    listener?.({ payload: { operation: "idle", update, checked: true, lastError: null } });
    pending.resolve({ operation: "idle", update: null, checked: false, lastError: null });
    await Promise.resolve(); await Promise.resolve();
    expect(controller.snapshot().update).toEqual(update);
    cancel();
  });

  it("rejects metadata whose encoded JSON exceeds the transport budget", async () => {
    const fake = fakeDependencies({ check: { ...update, body: "\0".repeat(11000) } });
    const controller = createAppUpdaterController(fake.deps);
    await expect(controller.check("manual")).rejects.toMatchObject({ code: "invalid_response" });
    expect(controller.snapshot().update).toBeNull();
  });

  it("does not present a pending check after lifecycle cancellation and permits a new check", async () => {
    const pending = deferred<AppUpdateMetadata | null>();
    const fake = fakeDependencies({ check: pending.promise });
    const controller = createAppUpdaterController(fake.deps);
    const cancel = controller.scheduleStartupCheck();
    const first = controller.check("manual");
    cancel();
    expect(controller.snapshot().phase).not.toBe("checking");
    pending.resolve(update); await first;
    expect(controller.snapshot().promptVisible).toBe(false);
    await controller.check("manual");
    expect(controller.snapshot().update).toEqual(update);
  });

  it("does not present a pending failure after lifecycle cancellation", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<AppUpdateMetadata | null>((_resolve, fail) => { reject = fail; });
    const fake = fakeDependencies({ check: pending });
    const controller = createAppUpdaterController(fake.deps);
    const cancel = controller.scheduleStartupCheck();
    const check = controller.check("manual"); cancel();
    reject({ code: "network", message: "failed" });
    await expect(check).rejects.toMatchObject({ code: "network" });
    expect(controller.snapshot()).toMatchObject({ phase: "idle", promptVisible: false, errorCode: "" });
  });

  it("keeps startup failures non-blocking and normalizes native errors", async () => {
    const fake = fakeDependencies({
      check: Promise.reject({ code: "network", message: "网络暂不可用" }),
    });
    const controller = createAppUpdaterController(fake.deps);

    await expect(controller.check("startup")).rejects.toMatchObject({ code: "network" });
    expect(controller.snapshot()).toMatchObject({
      phase: "error",
      errorCode: "network",
      errorMessage: "网络暂不可用",
      promptVisible: false,
    });
  });

  it("tracks known and unknown download totals and removes its listener", async () => {
    const fake = fakeDependencies();
    const controller = createAppUpdaterController(fake.deps);
    const stop = await controller.startProgressListener();

    fake.emitProgress({ event: "downloading", downloaded: 50, total: 100 });
    expect(controller.snapshot()).toMatchObject({
      phase: "downloading",
      downloaded: 50,
      total: 100,
    });
    fake.emitProgress({ event: "installing", downloaded: 75, total: null });
    expect(controller.snapshot()).toMatchObject({
      phase: "installing",
      downloaded: 75,
      total: null,
    });

    stop();
    expect(fake.unlisten).toHaveBeenCalledTimes(1);
  });

  it("dismisses without installing and installs the exact available version", async () => {
    const fake = fakeDependencies();
    const controller = createAppUpdaterController(fake.deps);
    await controller.check("manual");

    controller.dismiss();
    expect(controller.snapshot().promptVisible).toBe(false);
    expect(fake.invoke).toHaveBeenCalledTimes(1);

    await controller.installAndRestart();
    expect(fake.invoke).toHaveBeenLastCalledWith("install_app_update", {
      expectedVersion: "3.0.1",
      expectedCandidateId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(controller.snapshot().phase).toBe("restarting");
  });

  it("rejects install attempts when no update is available", async () => {
    const controller = createAppUpdaterController(fakeDependencies().deps);

    await expect(controller.installAndRestart()).rejects.toMatchObject({
      code: "no_update",
    });
  });

  it("does not invoke desktop commands in a browser preview", async () => {
    const fake = fakeDependencies({ desktop: false });
    const controller = createAppUpdaterController(fake.deps);

    await expect(controller.check("manual")).rejects.toMatchObject({
      code: "desktop_only",
    });
    expect(fake.invoke).not.toHaveBeenCalled();
  });
});

function promptState(patch: Partial<AppUpdaterState> = {}): AppUpdaterState {
  return {
    phase: "available",
    update,
    checkedAt: "2026-07-14T12:00:00.000Z",
    downloaded: 0,
    total: null,
    errorCode: "",
    errorMessage: "",
    promptVisible: true,
    ...patch,
  };
}

describe("app update prompt", () => {
  it("shows release details and keeps install explicitly user-triggered", async () => {
    const ondismiss = vi.fn();
    const oninstall = vi.fn();
    render(AppUpdaterHarness, {
      state: promptState(),
      ondismiss,
      oninstall,
    });

    expect(screen.getByText("发现新版本 3.0.1")).toBeTruthy();
    expect(screen.getByText("Security and reliability fixes")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(ondismiss).toHaveBeenCalledTimes(1);
    expect(oninstall).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "更新并重启" }));
    expect(oninstall).toHaveBeenCalledTimes(1);
  });

  it("renders release notes as text rather than executable HTML", () => {
    const view = render(AppUpdaterHarness, {
      state: promptState({
        update: { ...update, body: "<script>alert(1)</script>" },
      }),
      ondismiss: vi.fn(),
      oninstall: vi.fn(),
    });

    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
  });

  it("shows determinate and indeterminate download progress", () => {
    const first = render(AppUpdaterHarness, {
      state: promptState({ phase: "downloading", downloaded: 50, total: 100 }),
      ondismiss: vi.fn(),
      oninstall: vi.fn(),
    });
    expect(screen.getByText("正在下载 50%")).toBeTruthy();
    first.unmount();

    render(AppUpdaterHarness, {
      state: promptState({ phase: "downloading", downloaded: 50, total: null }),
      ondismiss: vi.fn(),
      oninstall: vi.fn(),
    });
    expect(screen.getByRole("progressbar", { name: "正在下载" })).toBeTruthy();
  });

  it("disables duplicate actions while installing", () => {
    render(AppUpdaterHarness, {
      state: promptState({ phase: "installing" }),
      ondismiss: vi.fn(),
      oninstall: vi.fn(),
    });

    expect((screen.getByRole("button", { name: "稍后" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "正在安装" }) as HTMLButtonElement).disabled).toBe(true);
  });
});


describe("automatic preference and explicit manual intent", () => {
  function setup() {
    const handlers = new Map<string, (event: {payload: unknown}) => void>();
    const pending = deferred<AppUpdateMetadata | null>();
    const fake = fakeDependencies({check: pending.promise});
    fake.deps.listen = vi.fn(async (name, handler) => {handlers.set(name, handler); return () => handlers.delete(name);});
    const invoke = fake.deps.invoke;
    fake.deps.invoke = vi.fn(async (name, args) => name === "get_setting" ? '{"autoCheckUpdate":false}' : invoke(name, args));
    const controller = createAppUpdaterController(fake.deps);
    const cancel = controller.scheduleStartupCheck();
    return {handlers, pending, fake, controller, cancel};
  }
  it("hides automatic discovery while off but preserves manual await after real status events", async () => {
    const s = setup(); await vi.waitFor(() => expect(s.handlers.size).toBe(2));
    await Promise.resolve(); await Promise.resolve();
    const available = {operation:"idle",update,checked:true,lastError:null};
    s.handlers.get("app-update-status")?.({payload:available});
    expect(s.controller.snapshot().promptVisible).toBe(false);
    const manual = s.controller.check("manual");
    s.handlers.get("app-update-status")?.({payload:{operation:"checking",update:null,checked:false,lastError:null}});
    s.handlers.get("app-update-status")?.({payload:available});
    s.pending.resolve(update); await manual;
    expect(s.controller.snapshot()).toMatchObject({phase:"available",promptVisible:true});
    s.handlers.get("app-update-status")?.({payload:{...available,lastError:{code:"download_failed",message:"下载失败"}}});
    expect(s.controller.snapshot()).toMatchObject({phase:"error",promptVisible:true});
    s.cancel(); expect(s.handlers.size).toBe(0);
  });
  it("a later preference event defeats a late startup read and dismissal returns to auto gating", async () => {
    const s = setup(); const read = deferred<unknown>();
    s.fake.deps.invoke = vi.fn(async name => name === "get_setting" ? read.promise : undefined);
    await vi.waitFor(() => expect(s.handlers.size).toBe(2));
    s.handlers.get("atools://renderer-general-settings")?.({payload:{version:1,raw:'{"autoCheckUpdate":false}'}});
    read.resolve('{"autoCheckUpdate":true}');await Promise.resolve();await Promise.resolve();
    s.handlers.get("app-update-status")?.({payload:{operation:"idle",update,checked:true,lastError:null}});
    expect(s.controller.snapshot().promptVisible).toBe(false);
    s.handlers.get("atools://renderer-general-settings")?.({payload:{version:1,raw:'{"autoCheckUpdate":true}'}});
    s.handlers.get("app-update-status")?.({payload:{operation:"idle",update,checked:true,lastError:null}});
    expect(s.controller.snapshot().promptVisible).toBe(true);s.cancel();
  });
});

describe("r79 review preference ordering", () => {
  function ordered() {
    const read = deferred<unknown>();
    const handlers = new Map<string, (event: {payload: unknown}) => void>();
    const fake = fakeDependencies();
    fake.deps.listen = vi.fn(async (name, handler) => {handlers.set(name, handler); return () => handlers.delete(name);});
    const invoke = fake.deps.invoke;
    fake.deps.invoke = vi.fn(async (name, args) => name === "get_setting" ? read.promise : invoke(name, args));
    const controller = createAppUpdaterController(fake.deps);
    const cancel = controller.scheduleStartupCheck();
    return {read, handlers, fake, controller, cancel};
  }
  it.each([true, false])("late preference %s reprojects prior availability without another check", async enabled => {
    const s = ordered(); await vi.waitFor(() => expect(s.handlers.size).toBe(2));
    s.handlers.get("app-update-status")?.({payload:{operation:"idle",update,checked:true,lastError:null}});
    expect(s.controller.snapshot().promptVisible).toBe(false);
    s.read.resolve(JSON.stringify({autoCheckUpdate:enabled}));
    await vi.waitFor(() => expect(s.controller.snapshot().promptVisible).toBe(enabled));
    expect(s.fake.deps.invoke).not.toHaveBeenCalledWith("check_app_update"); s.cancel();
  });
  it("explicit dismissal before the initial preference resolves is not revived", async () => {
    const s = ordered(); await vi.waitFor(() => expect(s.handlers.size).toBe(2));
    s.handlers.get("app-update-status")?.({payload:{operation:"idle",update,checked:true,lastError:null}});
    s.controller.dismiss(); s.read.resolve('{"autoCheckUpdate":true}');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(s.controller.snapshot().promptVisible).toBe(false); s.cancel();
  });
  it("duplicate preference does not replay a dismissed discovery or a progress/error event", async () => {
    const s = ordered(); await vi.waitFor(() => expect(s.handlers.size).toBe(2));
    s.read.resolve('{"autoCheckUpdate":true}'); await Promise.resolve(); await Promise.resolve();
    s.handlers.get("app-update-status")?.({payload:{operation:"idle",update,checked:true,lastError:null}});
    s.controller.dismiss();
    s.handlers.get("atools://renderer-general-settings")?.({payload:{version:1,raw:'{"autoCheckUpdate":true}'}});
    expect(s.controller.snapshot().promptVisible).toBe(false);
    const before = s.controller.snapshot();
    s.handlers.get("atools://renderer-general-settings")?.({payload:{version:1,raw:'{"autoCheckUpdate":true}'}});
    expect(s.controller.snapshot()).toEqual(before);s.cancel();
  });
  it("manual install progress remains visible with auto disabled", async () => {
    const s = ordered();await vi.waitFor(() => expect(s.handlers.size).toBe(2));
    s.read.resolve('{"autoCheckUpdate":false}');await Promise.resolve();await Promise.resolve();
    await s.controller.check("manual");expect(s.controller.snapshot().promptVisible).toBe(true);
    const stop=await s.controller.startProgressListener();
    await s.controller.installAndRestart();
    s.handlers.get("app-update-progress")?.({payload:{event:"downloading",downloaded:3,total:10}});
    expect(s.controller.snapshot()).toMatchObject({phase:"downloading",promptVisible:true,downloaded:3});
    stop();s.cancel();
  });
});
