import assert from "node:assert/strict";
import test from "node:test";
import { createOriginalBrowserNodeHost } from "./lib/original-plugin-browser-node-host.mjs";
import { allowedOriginalBrowserUrl } from "./lib/original-plugin-browser-runtime.mjs";
const owner = "12345678-1234-4234-8234-123456789abc";
const endpoint = "http://127.0.0.1:19191/node/" + "a".repeat(64);
function context(startImpl) {
  const report = {}, page = { on() {}, async send() {} };
  return createOriginalBrowserNodeHost(page, "/explicit-fixture-root", report, { startImpl }).then(host => ({ report, host }));
}
function fakeFixture() {
  let stops = 0;
  return { endpoint, initialize: { protocolVersion: 1, pid: 123, nodeVersion: "fixture" }, stats: { requests: 0 }, isolation: { inheritedAmbientEnvironment: false },
    async stop() { stops++; return { listenerClosed: true, nodeProcessStopped: true, isolatedEnvironmentRemoved: true, trackedProcessGroupCleanup: true }; }, get stops() { return stops; } };
}
test("fixture Node authority rejects foreign plugin/unknown session without starting a process", async () => {
  let starts = 0; const { host } = await context(async () => { starts++; return fakeFixture(); });
  await assert.rejects(host.request("prepare_legacy_node", { pluginId: "foreign", instanceId: owner }));
  await assert.rejects(host.request("get_legacy_node_session", { sessionId: "unknown" }));
  assert.equal(starts, 0); assert.equal((await host.close()).activeOwners, 0);
});
test("explicit preapproved session closes its exact process once, revokes lookup and retains only endpoint identity for late network observations", async () => {
  const fixture = fakeFixture(), { host, report } = await context(async () => fixture);
  const { sessionId } = await host.request("prepare_legacy_node", { pluginId: "image-stitch", instanceId: owner });
  assert.deepEqual(await host.request("get_legacy_node_session", { sessionId }), { endpoint });
  await host.request("close_legacy_node", { pluginId: "image-stitch", instanceId: owner });
  await assert.rejects(host.request("get_legacy_node_session", { sessionId }));
  const final = await host.close(); assert.equal(final.allNodeListenersAndProcessesStopped, true); assert.equal(fixture.stops, 1);
  assert.equal(report.nodeHost.stops.length, 1); assert.equal(allowedOriginalBrowserUrl(endpoint, 15134, host.endpoints), true);
  assert.equal(allowedOriginalBrowserUrl(endpoint + "/foreign", 15134, host.endpoints), false);
});
test("closing during in-flight Node preparation drains and stops the late owned fixture exactly once", async () => {
  let release; const fixture = fakeFixture(), { host } = await context(() => new Promise(resolve => { release = resolve; }));
  const preparing = host.request("prepare_legacy_node", { pluginId: "image-stitch", instanceId: owner });
  const expectedFailure = assert.rejects(preparing, /closed during preparation/);
  const closing = host.close(); release(fixture); await expectedFailure;
  const final = await closing; assert.equal(fixture.stops, 1); assert.equal(final.activeOwners, 0); assert.equal(final.activeSessions, 0); assert.equal(final.openings, 0); assert.equal(final.allNodeListenersAndProcessesStopped, true);
});
