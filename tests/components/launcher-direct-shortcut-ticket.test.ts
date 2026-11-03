import { expect, it, vi } from "vitest";
import { runTicketedDirectLaunch, subscribeLauncherDirectPluginLaunch } from "../../src/lib/launcherDirectPluginLaunch";

const request = { code: "feature", pluginId: "owner", shortcutDispatchId: "0123456789abcdef0123456789abcdef" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
it("waits for post-commit work to settle before completing the native ticket", async () => {
  const pending = deferred();
  const complete = vi.fn(async () => undefined);
  const run = runTicketedDirectLaunch(request, () => false, async record => {
    record("committed");
    await pending.promise;
  }, complete);
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();
  pending.resolve();
  await run;
  expect(complete).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledWith(request.shortcutDispatchId, "committed");
});
it("keeps an accepted activation alive after listener disposal and completes when it settles", async () => {
  const pending = deferred();
  const complete = vi.fn(async () => undefined);
  let receive!: (event: { payload: unknown }) => void;
  const stop = subscribeLauncherDirectPluginLaunch({
    subscribe: async callback => { receive = callback; return () => {}; },
    activate: (value, cancelled) => runTicketedDirectLaunch(value, cancelled, async (record, isCancelled) => {
      await pending.promise;
      record(isCancelled() ? "superseded" : "committed");
    }, complete),
    onError: vi.fn(),
  });
  await Promise.resolve();
  receive({ payload: request });
  await Promise.resolve();
  stop();
  expect(complete).not.toHaveBeenCalled();
  pending.resolve();
  await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(request.shortcutDispatchId, "superseded"));
});
