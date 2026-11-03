import { describe, expect, it, vi } from "vitest";
import { createPluginPageRevocationSubscription } from "../../src/lib/pluginPageRevocation";

describe("native document revocation subscription", () => {
  it("only closes the current native page once and detaches its listener", async () => {
    let receive!: (event: { payload: unknown }) => void;
    const stop = vi.fn(), onRevoked = vi.fn();
    const subscription = createPluginPageRevocationSubscription({ pageDocumentId: "current", onRevoked,
      listen: async (event, handler) => { expect(event).toBe("plugin-page-revoked"); receive = handler; return stop; } });
    await subscription.ready;
    for (const payload of [null, {}, { pageDocumentId: "old", reason: "navigation" }, { pageDocumentId: "current", reason: "other" }]) receive({ payload });
    expect(onRevoked).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    receive({ payload: { pageDocumentId: "current", reason: "navigation" } });
    receive({ payload: { pageDocumentId: "current", reason: "navigation" } });
    subscription.close(); expect(onRevoked).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
  });
  it("drains a registration resolving after close without reviving it", async () => {
    let finish!: (stop: () => void) => void, receive!: (event: { payload: unknown }) => void;
    const stop = vi.fn(), onRevoked = vi.fn();
    const subscription = createPluginPageRevocationSubscription({ pageDocumentId: "current", onRevoked,
      listen: (_event, handler) => { receive = handler; return new Promise(resolve => { finish = resolve; }); } });
    subscription.close(); receive({ payload: { pageDocumentId: "current", reason: "navigation" } });
    finish(stop); await subscription.ready;
    expect(stop).toHaveBeenCalledTimes(1); expect(onRevoked).not.toHaveBeenCalled();
  });
  it("propagates native subscription failure instead of reporting the page protected", async () => {
    const subscription = createPluginPageRevocationSubscription({ pageDocumentId: "current", onRevoked: vi.fn(),
      listen: async () => { throw Error("listener unavailable"); } });
    await expect(subscription.ready).rejects.toThrow("listener unavailable"); subscription.close();
  });
});
