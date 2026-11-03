import { describe, expect, it, vi } from "vitest";
import { settlePluginPanelLoad } from "../../src/lib/pluginPanelMountLoad";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("settlePluginPanelLoad", () => {
  it("mounts one current load", async () => {
    const loaded = deferred<{ id: string }>();
    const mounted = vi.fn();
    const failed = vi.fn();
    const task = settlePluginPanelLoad(() => loaded.promise, () => true, mounted, failed);

    loaded.resolve({ id: "active" });
    await task;

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledWith({ id: "active" });
    expect(failed).not.toHaveBeenCalled();
  });

  it("ignores a stale rejection after the action changes", async () => {
    const loaded = deferred<{ id: string }>();
    let active = true;
    const failed = vi.fn();
    const task = settlePluginPanelLoad(() => loaded.promise, () => active, vi.fn(), failed);

    active = false;
    loaded.reject(new Error("old import failed"));
    await task;

    expect(failed).not.toHaveBeenCalled();
  });

  it("ignores resolution after the effect is disposed", async () => {
    const loaded = deferred<{ id: string }>();
    let disposed = false;
    const mounted = vi.fn();
    const failed = vi.fn();
    const task = settlePluginPanelLoad(() => loaded.promise, () => !disposed, mounted, failed);

    disposed = true;
    loaded.resolve({ id: "unmounted" });
    await task;

    expect(mounted).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("ignores rejection after the effect is disposed", async () => {
    const loaded = deferred<{ id: string }>();
    let disposed = false;
    const mounted = vi.fn();
    const failed = vi.fn();
    const task = settlePluginPanelLoad(() => loaded.promise, () => !disposed, mounted, failed);

    disposed = true;
    loaded.reject(new Error("unmounted import failed"));
    await task;

    expect(mounted).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a failure for the current action", async () => {
    const error = new Error("current import failed");
    const failed = vi.fn();

    await settlePluginPanelLoad(() => Promise.reject(error), () => true, vi.fn(), failed);

    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledWith(error);
  });
});
