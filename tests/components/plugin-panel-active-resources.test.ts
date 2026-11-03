import { describe, expect, it, vi } from "vitest";
import { createPluginPanelActiveResources } from "../../src/lib/pluginPanelActiveResources";
import { closePluginPanelResourcesStrict } from "../../src/lib/pluginPanelCloseTracker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("plugin panel active AI resources", () => {
  it("closes the AI controller through the shared owner cleanup", () => {
    const resources = createPluginPanelActiveResources();
    const close = vi.fn();
    resources.ai = { close } as never;

    resources.closeAll();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("waits for every resource close and drains hidden IPC failures before rejecting", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const drain = vi.fn(async () => {});
    const close = vi.fn();
    const completion = closePluginPanelResourcesStrict([
      () => first.promise,
      () => { throw new Error("synchronous close failure"); },
      () => { close(); return second.promise; },
    ], drain);

    first.reject(new Error("deferred close failure"));
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();

    second.resolve();
    await expect(completion).rejects.toThrow("deferred close failure");
    expect(drain).toHaveBeenCalledOnce();
  });
});
