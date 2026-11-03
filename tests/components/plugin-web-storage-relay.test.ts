import { expect, it, vi } from "vitest";
import { PluginFrameSourceRegistry, pluginDocumentEnvelope } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginWebStorageRelay } from "../../src/lib/pluginWebStorageRelay";

it("delivers only event metadata to live frames of the current authorized plugin instance", async () => {
  const sources = new PluginFrameSourceRegistry();
  const main = { postMessage: vi.fn() }, child = { postMessage: vi.fn() }, stranger = { postMessage: vi.fn() };
  sources.setMain(main); sources.registerChild("child", child);
  let receive!: (event: { payload: unknown }) => void;
  const stop = vi.fn();
  let owner = { pluginId: "plugin", instanceId: "instance", authorized: true };
  const relay = createPluginWebStorageRelay({
    listen: async (_, callback) => { receive = callback; return stop; }, owner: () => owner,
    sources, targets: () => [main, child, stranger, child],
  });
  await relay.start();
  const payload = { pluginId: "plugin", instanceId: "instance", eventId: "a".repeat(32) };
  for (const invalid of [{ ...payload, pluginId: "other" }, { ...payload, instanceId: "old" },
    { ...payload, key: "must never be forwarded" }, { ...payload, eventId: "bad" }]) receive({ payload: invalid });
  expect(main.postMessage).not.toHaveBeenCalled();
  receive({ payload });
  expect(main.postMessage).toHaveBeenCalledTimes(1);
  expect(main.postMessage).toHaveBeenCalledWith({ __atools_web_storage_event__: true,
    instanceId: "instance", eventId: "a".repeat(32) }, "*");
  expect(child.postMessage).toHaveBeenCalledTimes(1);
  expect(stranger.postMessage).not.toHaveBeenCalled();
  sources.unregisterChild("child");
  owner = { ...owner, authorized: false }; receive({ payload });
  expect(main.postMessage).toHaveBeenCalledTimes(1);
  relay.close(); owner = { ...owner, authorized: true }; receive({ payload });
  expect(stop).toHaveBeenCalledTimes(1); expect(main.postMessage).toHaveBeenCalledTimes(1);
});

it("removes a listener which finishes registering after plugin destruction", async () => {
  let finish!: (stop: () => void) => void;
  const stop = vi.fn();
  const relay = createPluginWebStorageRelay({ listen: () => new Promise(resolve => { finish = resolve; }),
    owner: () => null, targets: () => [], sources: new PluginFrameSourceRegistry() });
  const pending = relay.start(); expect(relay.start()).toBe(pending);
  relay.close(); finish(stop); await pending;
  expect(stop).toHaveBeenCalledTimes(1);
  await expect(relay.start()).rejects.toThrow("closed");
});

it("relays through the host identity with its current document envelope and drops invalidated generations", async () => {
  const sources = new PluginFrameSourceRegistry();
  const main = { postMessage: vi.fn() };
  const origin = "atools-page://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost";
  const parentOrigin = "atools-panel://localhost";
  const firstReservation = sources.reserveDocument({ kind: "main", source: main, pageDocumentId: "a".repeat(32),
    expectedOrigin: origin, parentOrigin });
  const firstIdentity = sources.activateDocument(firstReservation, "b".repeat(32))!;
  expect(sources.identify(main)).toBeNull();
  let receive!: (event: { payload: unknown }) => void;
  const relay = createPluginWebStorageRelay({ listen: async (_, callback) => { receive = callback; return () => {}; },
    owner: () => ({ pluginId: "plugin", instanceId: "instance", authorized: true }),
    targets: () => [main], sources });
  await relay.start();
  const metadata = { pluginId: "plugin", instanceId: "instance", eventId: "c".repeat(32) };
  receive({ payload: metadata });
  expect(main.postMessage).toHaveBeenCalledWith({ __atools_web_storage_event__: true, instanceId: "instance",
    eventId: metadata.eventId, __atoolsDocument: pluginDocumentEnvelope(firstIdentity) }, origin);

  sources.invalidateDocument(firstReservation);
  receive({ payload: metadata });
  expect(main.postMessage).toHaveBeenCalledTimes(1);

  const secondReservation = sources.reserveDocument({ kind: "main", source: main, pageDocumentId: "d".repeat(32),
    expectedOrigin: origin, parentOrigin });
  const secondIdentity = sources.activateDocument(secondReservation, "e".repeat(32))!;
  receive({ payload: metadata });
  expect(main.postMessage).toHaveBeenCalledTimes(2);
  expect(main.postMessage.mock.calls[1][0].__atoolsDocument).toEqual(pluginDocumentEnvelope(secondIdentity));
  expect(main.postMessage.mock.calls[1][0].__atoolsDocument).not.toEqual(pluginDocumentEnvelope(firstIdentity));
  relay.close();
});
