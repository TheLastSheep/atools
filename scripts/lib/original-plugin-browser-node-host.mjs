import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { startNodeFixture } from "./legacy-node-webkit-fixture.mjs";

function browserNodeHostClient() {
  const pending = new Map(); let sequence = 0;
  window.__originalNodeHostDeliver = response => {
    const request = pending.get(response.id); if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    if (response.error) request.reject(Error(response.error)); else request.resolve(response.result);
  };
  window.__originalNodeHostRequest = (command, args) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Fixture Node host request deadline: " + command)); }, 10000);
    pending.set(id, { resolve, reject, timer }); window.__originalNodeHostCall(JSON.stringify({ id, command, args }));
  });
}

/** Real current Node protocol process; native permission and session lookup remain explicit host doubles. */
export async function createOriginalBrowserNodeHost(page, root, report, { startImpl = startNodeFixture } = {}) {
  const sessions = new Map(), owners = new Map(), openings = new Map(), stopping = new Map(), operations = new Set(), endpoints = new Set();
  let closing = false;
  report.nodeHost = { nativeAuthorization: "fixture preapproved service double; not Rust PermissionDecision/TaskRun", runtime: "system Node with current repository codec/bootstrap; not packaged runtime",
    calls: [], createdProcesses: 0, opened: [], stops: [], errors: [] };
  function stop(owner, fixture) {
    if (stopping.has(owner)) return stopping.get(owner);
    const operation = (async () => {
    const stats = structuredClone(fixture.stats), cleanup = await fixture.stop();
    report.nodeHost.stops.push({ owner, stats, cleanup });
    assert.equal(cleanup.listenerClosed, true); assert.equal(cleanup.nodeProcessStopped, true); assert.equal(cleanup.isolatedEnvironmentRemoved, true); assert.equal(cleanup.trackedProcessGroupCleanup, true);
    owners.delete(owner);
    for (const [id, value] of sessions) if (value.owner === owner) sessions.delete(id);
    })(); stopping.set(owner, operation); return operation;
  }
  async function request(command, args) {
    const call = { command, args, status: "started" }; report.nodeHost.calls.push(call);
    try {
      if (command === "get_legacy_node_session") {
        const value = sessions.get(args?.sessionId); assert.ok(value && !closing, "Unknown or closed fixture Node session");
        call.status = "succeeded"; call.output = { endpointOrigin: new URL(value.fixture.endpoint).origin, bearerRedacted: true };
        return { endpoint: value.fixture.endpoint };
      }
      assert.equal(args?.pluginId, "image-stitch", "Node fixture owns only image-stitch");
      assert.match(args?.instanceId || "", /^[a-f0-9-]{36}$/); assert.equal(args?.selectedPreload, undefined);
      const owner = args.instanceId;
      if (command === "prepare_legacy_node") {
        assert.equal(closing, false); assert.equal(owners.has(owner) || openings.has(owner), false, "Duplicate Node owner");
        const opening = startImpl(root, resolve(root, "ZTools-plugins/plugins/image-stitch"), resolve(root, "ZTools-plugins/plugins/image-stitch/index.html"));
        openings.set(owner, opening); let fixture;
        try { fixture = await opening; } finally { openings.delete(owner); }
        owners.set(owner, fixture); report.nodeHost.createdProcesses++;
        if (closing) { await stop(owner, fixture); throw Error("Node fixture closed during preparation"); }
        const sessionId = randomUUID(); sessions.set(sessionId, { owner, fixture }); endpoints.add(fixture.endpoint);
        const evidence = { owner, sessionId, initialize: fixture.initialize, isolation: fixture.isolation,
          endpointOrigin: new URL(fixture.endpoint).origin, selectedAnchor: "unchanged original image-stitch/index.html", nativeAuthorization: "fixture preapproved" };
        report.nodeHost.opened.push(evidence); call.status = "succeeded"; call.output = { sessionId }; return { sessionId };
      }
      assert.equal(command, "close_legacy_node", "Unexpected fixture Node operation");
      if (openings.has(owner)) await openings.get(owner);
      const fixture = owners.get(owner); if (fixture) await stop(owner, fixture);
      call.status = "succeeded"; return null;
    } catch (error) { call.status = "failed"; call.error = error.message; throw error; }
  }
  page.on("Runtime.bindingCalled", event => {
    if (event.name !== "__originalNodeHostCall") return;
    const operation = (async () => {
      let value;
      try {
        const input = JSON.parse(event.payload); assert.ok(Number.isSafeInteger(input.id));
        try { value = { id: input.id, result: await request(input.command, input.args) }; }
        catch (error) { value = { id: input.id, error: error.message }; }
        await page.send("Runtime.evaluate", { contextId: event.executionContextId,
          expression: `window.__originalNodeHostDeliver(${JSON.stringify(value)})`, returnByValue: true });
      } catch (error) { report.nodeHost.errors.push(error.message); }
    })();
    operations.add(operation); void operation.finally(() => operations.delete(operation));
  });
  await page.send("Runtime.addBinding", { name: "__originalNodeHostCall" });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${browserNodeHostClient.toString()})();` });
  return { request, endpoints, async close() {
    closing = true; await Promise.all([...operations]);
    await Promise.allSettled([...openings.values()]);
    for (const [owner, fixture] of [...owners]) await stop(owner, fixture);
    await Promise.all([...stopping.values()]);
    assert.deepEqual(report.nodeHost.errors, []);
    return { activeSessions: sessions.size, activeOwners: owners.size, openings: openings.size, pendingOperations: operations.size,
      allNodeListenersAndProcessesStopped: report.nodeHost.stops.length === report.nodeHost.createdProcesses && report.nodeHost.stops.every(item => item.cleanup.listenerClosed && item.cleanup.nodeProcessStopped && item.cleanup.isolatedEnvironmentRemoved && item.cleanup.trackedProcessGroupCleanup) };
  } };
}
