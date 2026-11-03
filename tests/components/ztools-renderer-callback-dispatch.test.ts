import { describe, expect, it, vi } from "vitest";
import { dispatchRendererCallbacks } from "../../packages/ztools-renderer/src/callbackRegistry";

describe("ZTools renderer callback dispatch", () => {
  it("uses an ordered snapshot, skips removed callbacks, and defers new callbacks to the next dispatch", () => {
    const calls: string[] = [];
    const callbacks = new Map<number, (payload: string) => unknown>();
    let unsubscribeSecond = () => undefined;
    callbacks.set(1, (payload) => {
      calls.push(`first:${payload}`);
      unsubscribeSecond();
      if (!callbacks.has(3)) callbacks.set(3, (nextPayload) => calls.push(`third:${nextPayload}`));
    });
    callbacks.set(2, (payload) => calls.push(`second:${payload}`));
    unsubscribeSecond = () => { callbacks.delete(2); };

    dispatchRendererCallbacks(callbacks, ["first-payload"]);
    expect(calls).toEqual(["first:first-payload"]);

    dispatchRendererCallbacks(callbacks, ["second-payload"]);
    expect(calls).toEqual(["first:first-payload", "first:second-payload", "third:second-payload"]);
  });

  it("counts synchronous throws, promise rejections, and thenable errors once each", async () => {
    const errors: string[] = [];
    const callbacks = new Map<number, () => unknown>([
      [1, () => { throw new Error("sync"); }],
      [2, () => Promise.reject(new Error("async"))],
      [3, () => ({ then() { throw new Error("then"); } })],
    ]);

    dispatchRendererCallbacks(callbacks, [], () => { errors.push("callback error"); });

    await vi.waitFor(() => expect(errors).toHaveLength(3));
    expect(errors).toEqual(["callback error", "callback error", "callback error"]);
  });

  it("checks client delivery gates for every recipient and calls callbacks without a receiver", () => {
    const calls: number[] = [];
    let active = true;
    let gateChecks = 0;
    let observedThis: unknown = "not-called";
    const callbacks = new Map<number, (this: unknown) => unknown>();
    callbacks.set(1, function (this: unknown) {
      observedThis = this;
      calls.push(1);
      active = false;
    });
    callbacks.set(2, () => calls.push(2));

    dispatchRendererCallbacks(callbacks, [], undefined, () => {
      gateChecks += 1;
      return active;
    });

    expect(gateChecks).toBe(2);
    expect(calls).toEqual([1]);
    expect(observedThis).toBeUndefined();
  });
});
