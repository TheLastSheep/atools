import { describe, expect, it, vi } from "vitest";

import {
  createAppUpdaterController,
  type AppUpdateMetadata,
  type AppUpdateProgress,
  type AppUpdaterDependencies,
} from "../../src/lib/appUpdater";

const update: AppUpdateMetadata = {
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
  let progressHandler: ((event: { payload: AppUpdateProgress }) => void) | undefined;
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

  it("schedules one delayed startup check and can cancel it", async () => {
    const fake = fakeDependencies();
    const controller = createAppUpdaterController(fake.deps);

    const cancel = controller.scheduleStartupCheck();
    expect(fake.deps.setTimer).toHaveBeenCalledWith(expect.any(Function), 3000);
    fake.fireTimer();
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledTimes(1));
    cancel();
    expect(fake.deps.clearTimer).toHaveBeenCalledWith(3000);
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
