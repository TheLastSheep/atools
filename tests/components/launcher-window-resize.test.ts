import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLauncherWindowResize, WINDOW_RESIZE_FAILURE_NOTICE } from "../../src/lib/launcherWindowResize.svelte";
import WindowResizeNotice from "../../src/components/WindowResizeNotice.svelte";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("launcher window resize", () => {
  it("does not invoke native resize outside Tauri and rounds one runtime request", async () => {
    let available = false;
    const invokeResize = vi.fn(async (_height: number) => {});
    const controller = createLauncherWindowResize({ hasRuntime: () => available, invokeResize });

    await controller.resize(42.5);
    expect(invokeResize).not.toHaveBeenCalled();
    expect(controller.notice).toBeNull();

    available = true;
    await controller.resize(42.5);
    expect(invokeResize).toHaveBeenCalledTimes(1);
    expect(invokeResize).toHaveBeenCalledWith(43);
    expect(controller.notice).toBeNull();
    controller.dispose();
  });

  it("shows only the fixed notice when an invoke rejects and clears it after an explicit successful resize", async () => {
    const invokeResize = vi.fn()
      .mockRejectedValueOnce(new Error("native path /private/user/window token=secret"))
      .mockResolvedValueOnce(undefined);
    const controller = createLauncherWindowResize({ hasRuntime: () => true, invokeResize });

    await expect(controller.resize(300)).resolves.toBeUndefined();
    expect(controller.notice).toBe(WINDOW_RESIZE_FAILURE_NOTICE);
    expect(controller.notice).not.toContain("/private/user");
    expect(controller.notice).not.toContain("secret");

    await controller.resize(320);
    expect(invokeResize).toHaveBeenCalledTimes(2);
    expect(controller.notice).toBeNull();
    controller.dispose();
  });

  it("lets only the newest overlapping resize settle the notice", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    const invokeResize = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const controller = createLauncherWindowResize({ hasRuntime: () => true, invokeResize });

    const first = controller.resize(300);
    const second = controller.resize(320);
    newer.reject(new Error("newest failure"));
    await second;
    expect(controller.notice).toBe(WINDOW_RESIZE_FAILURE_NOTICE);

    older.resolve();
    await first;
    expect(controller.notice).toBe(WINDOW_RESIZE_FAILURE_NOTICE);
    controller.dispose();
  });

  it("does not let an older failure replace a newer success", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    const invokeResize = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const controller = createLauncherWindowResize({ hasRuntime: () => true, invokeResize });

    const first = controller.resize(300);
    const second = controller.resize(320);
    newer.resolve();
    await second;
    older.reject(new Error("stale failure"));
    await first;
    expect(controller.notice).toBeNull();
    controller.dispose();
  });

  it("turns non-finite and out-of-u32 heights into a fixed notice without invoking Tauri", async () => {
    const invokeResize = vi.fn(async (_height: number) => {});
    const controller = createLauncherWindowResize({ hasRuntime: () => true, invokeResize });

    await controller.resize(Number.NaN);
    expect(controller.notice).toBe(WINDOW_RESIZE_FAILURE_NOTICE);
    expect(invokeResize).not.toHaveBeenCalled();

    controller.dismiss();
    await controller.resize(0x1_0000_0000);
    expect(controller.notice).toBe(WINDOW_RESIZE_FAILURE_NOTICE);
    expect(invokeResize).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("dismisses the notice and makes disposal terminal for in-flight and later calls", async () => {
    const pending = deferred<void>();
    const invokeResize = vi.fn()
      .mockRejectedValueOnce(new Error("failure"))
      .mockImplementationOnce(() => pending.promise);
    const controller = createLauncherWindowResize({ hasRuntime: () => true, invokeResize });

    await controller.resize(300);
    expect(controller.notice).toBe(WINDOW_RESIZE_FAILURE_NOTICE);
    controller.dismiss();
    expect(controller.notice).toBeNull();

    const inFlight = controller.resize(320);
    controller.dispose();
    pending.reject(new Error("late failure"));
    await inFlight;
    await controller.resize(360);
    expect(invokeResize).toHaveBeenCalledTimes(2);
    expect(controller.notice).toBeNull();
  });
});

describe("window resize notice", () => {
  it("announces a fixed recovery message, closes accessibly, and leaves focus where it was", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onclose = vi.fn();
    render(WindowResizeNotice, { onclose });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("窗口大小调整失败");
    expect(alert.textContent).toContain("可滚动查看内容或重新打开窗口");
    const close = screen.getByRole("button", { name: "关闭窗口大小调整提示" });
    expect(close.hasAttribute("autofocus")).toBe(false);
    expect(document.activeElement).toBe(trigger);

    await fireEvent.click(close);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
