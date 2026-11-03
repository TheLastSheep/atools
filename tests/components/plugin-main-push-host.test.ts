import { afterEach, expect, it, vi } from "vitest";
import { createPluginMainPushHost } from "../../src/lib/pluginMainPushHost";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginMainPushPermissionTracker } from "../../src/lib/pluginMainPushPermissions";
import { createPluginMainPushDeadline } from "../../src/lib/pluginMainPushDeadline";

function fixture() {
  const source = { postMessage: vi.fn() }, sources = new PluginFrameSourceRegistry(); sources.setMain(source);
  const identity = sources.currentIdentityForHost(source)!;
  const host = createPluginMainPushHost({ runnerId: "runner", featureCode: "feature", parentOrigin: window.origin,
    source: () => source as unknown as Window, sources, mode: vi.fn() }); host.reset(1);
  function receive(data: Record<string, unknown>, origin = "null", target: unknown = source) {
    return host.receive({ source: target, origin, data: { __atools_main_push__: true, ...host.configuration(), ...data } } as MessageEvent, identity);
  }
  return { source, sources, identity, host, receive };
}
afterEach(() => vi.useRealTimers());

it("requires current source, exact null origin, nonce and epoch at the host receiver", async () => {
  const f = fixture();
  expect(f.receive({ booted: true, registered: true }, "https://example.invalid")).toBe(false);
  expect(f.receive({ booted: true, registered: true }, "null", {})).toBe(false);
  expect(f.receive({ nonce: "other", booted: true, registered: true })).toBe(false);
  expect(f.receive({ epoch: 2, booted: true, registered: true })).toBe(false);
  expect(f.receive({ booted: true, registered: true })).toBe(true); await f.host.ready();
  const pending = f.host.query("q", 1, "  exact 😀  ", "over"); await Promise.resolve();
  expect(f.source.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ payload: "  exact 😀  ", requestId: "q" });
  f.receive({ requestId: "q", outcome: "ready", rows: [{ handle: "q:0", text: "Fixed", description: "", icon: "", highlight: true }] });
  expect((await pending).rows?.[0].text).toBe("Fixed"); f.host.close();
});
it("requires the active native document origin plus the existing document envelope", () => {
  const f = fixture();
  const reservation = f.sources.reserveDocument({ kind: "main", source: f.source, pageDocumentId: "page", expectedOrigin: "atools-page://fixed.localhost", parentOrigin: window.origin });
  const identity = f.sources.activateDocument(reservation, "a".repeat(32))!;
  const data = { __atools_main_push__: true, ...f.host.configuration(), booted: true, registered: true };
  expect(f.host.receive({ source: f.source, origin: "null", data } as unknown as MessageEvent, identity)).toBe(false);
  // The outer PluginPanel identifyEvent gate additionally checks __atoolsDocument.
  expect(f.sources.identifyEvent({ source: f.source, origin: identity.expectedOrigin, data })).toBeNull();
  f.host.close();
});
it("closed document generations and cancellation reject pending work; late replies cannot revive it", async () => {
  const f = fixture(); f.receive({ booted: true, registered: true });
  const pending = f.host.query("q", 1, "fixed", "text"); await Promise.resolve();
  const error = pending.catch(value => value); f.host.cancel(); expect((await error).message).toBe("ERR_MAIN_PUSH_SUPERSEDED");
  f.receive({ requestId: "q", outcome: "ready", rows: [] });
  f.sources.unregisterMain(f.source); expect(f.receive({ booted: true, registered: true })).toBe(false); f.host.close();
});
it("response limits fail explicitly and visible permission waiting pauses active callback deadline", async () => {
  vi.useFakeTimers(); const f = fixture(); f.receive({ booted: true, registered: true });
  const invalid = f.host.query("invalid", 1, "fixed", "text"); await Promise.resolve();
  const error = invalid.catch(value => value); f.receive({ requestId: "invalid", outcome: "ready", rows: Array(21).fill({}) });
  expect((await error).message).toBe("ERR_MAIN_PUSH_RESPONSE");
  const pending = f.host.query("q", 1, "fixed", "text"); await Promise.resolve();
  f.host.setWaiting(true); await vi.advanceTimersByTimeAsync(5000);
  f.host.setWaiting(false); f.receive({ requestId: "q", outcome: "empty", rows: [] }); expect((await pending).outcome).toBe("empty");
  f.host.close();
});
it("permission tracker observes exact current setup tasks without granting anything", async () => {
  const changed = vi.fn(); const tracker = createPluginMainPushPermissionTracker(changed);
  const invoke = vi.fn(async (command: string) => command === "prepare_legacy_node" ? { permission_required: true, runId: "run" } : { status: "succeeded" });
  const wrapped = tracker.wrap(invoke as any);
  await wrapped("prepare_legacy_node"); expect(changed).toHaveBeenLastCalledWith(true);
  await wrapped("get_task_run", { id: "other" }); expect(changed).toHaveBeenCalledTimes(1);
  await wrapped("get_task_run", { id: "run" }); expect(changed).toHaveBeenLastCalledWith(false);
  expect(invoke.mock.calls.map(call => call[0])).not.toContain("grant_agent_tool");
  tracker.setLocal(true); tracker.close(); expect(changed).toHaveBeenLastCalledWith(false);
});
it("startup deadline counts executing time and remains cancellable during permission waiting", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); const deadline = createPluginMainPushDeadline(5000);
  const pending = deadline.wait(new Promise(() => undefined)).catch(value => value);
  await vi.advanceTimersByTimeAsync(1000); deadline.setWaiting(true); await vi.advanceTimersByTimeAsync(30000);
  deadline.setWaiting(false); await vi.advanceTimersByTimeAsync(4001); expect((await pending).message).toBe("ERR_MAIN_PUSH_STARTUP_TIMEOUT");
  const cancelled = createPluginMainPushDeadline(5000), cancellation = cancelled.wait(new Promise(() => undefined)).catch(value => value);
  cancelled.setWaiting(true); cancelled.close(); expect((await cancellation).message).toBe("ERR_MAIN_PUSH_SUPERSEDED");
});
it("a select that never replies rejects at its active deadline and a late completion cannot revive it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); const f = fixture(); f.receive({ booted: true, registered: true });
  const pending = f.host.select("select", "query", 1, "query:0").catch(error => error); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(3001); expect((await pending).message).toBe("ERR_MAIN_PUSH_TIMEOUT");
  f.receive({ requestId: "select", outcome: "enter" }); f.host.close(); expect(vi.getTimerCount()).toBe(0);
});
