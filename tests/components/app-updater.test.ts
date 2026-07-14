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
