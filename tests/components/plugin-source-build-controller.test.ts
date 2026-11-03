import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginSourceBuildController } from "../../src/lib/pluginSourceBuildController";
import type { SourceBuildInspection, SourceBuildRuntime, SourceBuildServices } from "../../src/lib/pluginSourceBuildProtocol";
import type { TaskRun } from "../../src/lib/types";
import type { ManifestCandidate } from "../../src/lib/pluginSourceBuildManifest";

const path = "/synthetic/source-plugin";
const revision = "a".repeat(64);
const eligible: SourceBuildInspection = { status: "eligible", pluginId: "source-plugin", version: "1.0.0", blockers: [], sourceRevision: revision };
const manifestIdentity = { id: "source-plugin", version: "1.0.0", main: "index.html", preload: null, runtime: "web" as const, featureCodes: ["open"] };
const inspectionOutput = (patch: Partial<SourceBuildInspection> = {}): SourceBuildInspection => {
  const identity = patch.manifestIdentity;
  return { status: "eligible", pluginId: identity?.id ?? "source-plugin", version: identity?.version ?? "1.0.0", blockers: [], sourceRevision: revision, ...patch };
};
const inspectTask = (patch: Partial<TaskRun> = {}): TaskRun => ({ id: "inspect-run", capabilityId: "inspect_ztools_source_build", initiator: { type: "human", clientId: "atools-ui" }, status: "succeeded", input: { sourcePath: path }, output: inspectionOutput(), ...patch } as TaskRun);
const withManifests = (selection: "root" | "public" | null, difference = false): Partial<SourceBuildInspection> => {
  const identity = manifestIdentity;
  const publishedIdentity = difference ? { ...identity, version: "2.0.0" } : identity;
  const candidates: [ManifestCandidate, ManifestCandidate] = [
    { selection: "root", status: "valid", manifestSha256: "b".repeat(64), identity },
    { selection: "public", status: "valid", manifestSha256: "c".repeat(64), identity: publishedIdentity },
  ];
  const chosen = selection === "root" ? candidates[0] : selection === "public" ? candidates[1] : null;
  return { manifestSelection: selection, manifestSha256: chosen?.manifestSha256 ?? null, manifestIdentity: chosen?.identity ?? null, manifestCandidates: candidates, manifestDifferences: difference ? ["version"] : [] };
};
const running: SourceBuildRuntime = { active: true, stage: "building", cancellable: true, cancelRequested: false };
function task(patch: Partial<TaskRun> = {}): TaskRun {
  return { id: "run-1", capabilityId: "convert_ztools_plugin", initiator: { type: "human", clientId: "atools-ui" }, status: "running",
    input: { sourcePath: path, expectedRevision: revision, overwrite: true }, output: null, ...patch } as TaskRun;
}
function setup() {
  let receive: (id: string) => void = () => {};
  const stop = vi.fn();
  const services: SourceBuildServices = {
    inspect: vi.fn(async (_path: string, selection?: "root" | "public") => inspectTask({ input: { sourcePath: path, ...(selection ? { manifestSelection: selection } : {}) }, output: inspectionOutput() })),
    start: vi.fn(async () => task()), read: vi.fn(async id => id === "inspect-run" ? inspectTask() : task()),
    runtime: vi.fn(async () => running), cancel: vi.fn(async () => task()), installed: vi.fn(async () => {}),
    listen: vi.fn(async handler => { receive = handler; return stop; }),
  };
  const changed = vi.fn();
  const controller = new PluginSourceBuildController(services, changed);
  return { controller, services, changed, stop, emit: (id = "run-1") => receive(id), entry: () => controller.snapshot.entries[path] };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = async () => { await vi.advanceTimersByTimeAsync(250); };
const succeeded = () => task({ status: "succeeded", output: { pluginId: "source-plugin", version: "1.0.0", installed: true, sourceRevision: revision } });

it("does no eager inspection, listening or polling before a user selects a source", () => {
  const f = setup();
  expect(f.controller.snapshot.activePath).toBeNull();
  expect(f.services.inspect).not.toHaveBeenCalled();
  expect(f.services.listen).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.controller.dispose();
});

it("keeps unsupported and missing-dependency preflights out of the execution pipeline", async () => {
  const f = setup();
  vi.mocked(f.services.inspect).mockResolvedValue(inspectTask({ output: { status: "blocked", blockers: [{ code: "MISSING_DEPENDENCIES", message: "缺少本地依赖" }] } }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("blocked");
  expect(f.entry().inspection?.blockers[0].code).toBe("MISSING_DEPENDENCIES");
  expect(f.services.start).not.toHaveBeenCalled();
  expect(f.services.listen).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.controller.dispose();
});

it("rejects an eligible inspection without its exact source revision", async () => {
  const f = setup();
  vi.mocked(f.services.inspect).mockResolvedValue(inspectTask({ output: { ...eligible, sourceRevision: undefined } }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("failed");
  expect(f.services.start).not.toHaveBeenCalled();
  f.controller.dispose();
});

it("keeps already-ready paths on the direct-import flow without creating a conversion", async () => {
  const f = setup();
  vi.mocked(f.services.inspect).mockResolvedValue(inspectTask({ output: { status: "already_ready", blockers: [] } }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("already_ready");
  expect(f.services.start).not.toHaveBeenCalled();
  f.controller.dispose();
});

it("waits for the authoritative task instead of trusting a succeeded start response", async () => {
  const f = setup();
  vi.mocked(f.services.start).mockResolvedValue(succeeded());
  vi.mocked(f.services.read).mockResolvedValue(task({ status: "awaiting_permission" }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("awaiting_permission");
  expect(f.services.installed).not.toHaveBeenCalled();
  expect(f.services.start).toHaveBeenCalledWith(path, revision, undefined, undefined);
  f.controller.dispose();
});

it.each([
  { id: "another-run" }, { capabilityId: "other_tool" }, { initiator: { type: "agent", clientId: "atools-ui" } },
  { initiator: { type: "human", clientId: "other-ui" } }, { input: { sourcePath: "/other", expectedRevision: revision, overwrite: true } },
  { input: { sourcePath: path, expectedRevision: "b".repeat(64), overwrite: true } },
  { input: { sourcePath: path, expectedRevision: revision, overwrite: false } },
] as Partial<TaskRun>[])("rejects mismatched task identity %j without accepting success", async patch => {
  const f = setup();
  vi.mocked(f.services.read).mockResolvedValue({ ...succeeded(), ...patch });
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().observationError).toContain("身份");
  expect(f.entry().phase).not.toBe("succeeded");
  expect(f.services.installed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await Promise.resolve();
  f.emit();
  expect(f.services.read).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});

it("refreshes the actual installed catalog only after verified durable success and drains observation", async () => {
  const f = setup();
  await f.controller.inspect(path);
  await f.controller.convert(path);
  f.emit("unrelated-run");
  expect(f.services.read).toHaveBeenCalledTimes(1);
  vi.mocked(f.services.read).mockResolvedValue(succeeded());
  await tick();
  expect(f.services.installed).toHaveBeenCalledTimes(1);
  expect(f.services.installed).toHaveBeenCalledWith("source-plugin");
  expect(f.entry().phase).toBe("succeeded");
  expect(f.controller.snapshot.activePath).toBeNull();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  f.controller.dispose();
});

it.each([
  { installed: false }, { sourceRevision: "b".repeat(64) }, { pluginId: "other" }, { version: "2.0.0" },
])("never reports installation from an invalid succeeded output %j", async output => {
  const f = setup();
  const run = succeeded(); run.output = { ...(run.output as object), ...output };
  vi.mocked(f.services.read).mockResolvedValue(run);
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("failed");
  expect(f.services.installed).not.toHaveBeenCalled();
  f.controller.dispose();
});

it("keeps running cancellation active until native process cleanup is durably terminal", async () => {
  const f = setup();
  await f.controller.inspect(path);
  await f.controller.convert(path);
  vi.mocked(f.services.runtime).mockResolvedValue({ ...running, stage: "cancelling", cancelRequested: true });
  await f.controller.cancel(path);
  expect(f.entry().phase).toBe("cancelling");
  expect(f.controller.snapshot.activePath).toBe(path);
  expect(f.services.cancel).toHaveBeenCalledTimes(1);
  expect(f.services.cancel).toHaveBeenCalledWith("run-1");
  await f.controller.cancel(path);
  expect(f.services.cancel).toHaveBeenCalledTimes(1);
  vi.mocked(f.services.read).mockResolvedValue(task({ status: "cancelled" }));
  await tick();
  expect(f.entry().phase).toBe("cancelled");
  expect(f.controller.snapshot.activePath).toBeNull();
  expect(f.services.installed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.controller.dispose();
});

it("does not cancel during the non-cancellable install transaction", async () => {
  const f = setup();
  vi.mocked(f.services.runtime).mockResolvedValue({ ...running, stage: "installing", cancellable: false });
  await f.controller.inspect(path);
  await f.controller.convert(path);
  await f.controller.cancel(path);
  expect(f.entry().phase).toBe("installing");
  expect(f.services.cancel).not.toHaveBeenCalled();
  f.controller.dispose();
});

it("cancels an awaiting-permission task without treating a cancel response as final proof", async () => {
  const f = setup();
  vi.mocked(f.services.read).mockResolvedValue(task({ status: "awaiting_permission" }));
  vi.mocked(f.services.runtime).mockResolvedValue({ active: false, stage: "finished", cancellable: false, cancelRequested: false });
  await f.controller.inspect(path);
  await f.controller.convert(path);
  vi.mocked(f.services.cancel).mockResolvedValue(task({ status: "cancelled" }));
  await f.controller.cancel(path);
  expect(f.entry().phase).toBe("cancelling");
  expect(f.controller.snapshot.activePath).toBe(path);
  vi.mocked(f.services.read).mockResolvedValue(task({ status: "cancelled" }));
  await tick();
  expect(f.entry().phase).toBe("cancelled");
  expect(f.entry().message).toBe("转换已取消。");
  expect(f.controller.snapshot.activePath).toBeNull();
  f.controller.dispose();
});

it("explains a dismissed permission request and waits for an explicit new conversion", async () => {
  const f = setup();
  vi.mocked(f.services.read).mockResolvedValueOnce(task({
    status: "cancelled",
    summary: "Permission request was dismissed",
  }));

  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("cancelled");
  expect(f.entry().message).toBe("本次转换未获授权。可重新检查后再次发起，并在授权弹窗中自行决定是否允许。");
  expect(f.services.start).toHaveBeenCalledTimes(1);
  expect(f.services.installed).not.toHaveBeenCalled();

  await f.controller.inspect(path);
  expect(f.entry().phase).toBe("eligible");
  expect(f.services.start).toHaveBeenCalledTimes(1);
  await f.controller.convert(path);
  expect(f.services.start).toHaveBeenCalledTimes(2);
  f.controller.dispose();
});

it("preserves task errors and unrelated summaries ahead of dismissal wording", async () => {
  const f = setup();
  vi.mocked(f.services.read).mockResolvedValueOnce(task({
    status: "cancelled",
    summary: "Permission request was dismissed",
    errors: [{ code: "PERMISSION_REJECTED", message: "原始任务错误", details: null, retryable: false }],
  }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().message).toBe("原始任务错误");

  const other = setup();
  vi.mocked(other.services.read).mockResolvedValueOnce(task({ status: "cancelled", summary: "Other cancellation reason" }));
  await other.controller.inspect(path);
  await other.controller.convert(path);
  expect(other.entry().message).toBe("Other cancellation reason");
  f.controller.dispose();
  other.controller.dispose();
});

it.each(["failed", "partial"] as const)("reports a %s task without registering an installed plugin", async status => {
  const f = setup();
  vi.mocked(f.services.read).mockResolvedValue(task({ status, errors: [{ code: "BUILD_ERROR", message: "原构建命令失败", details: null, retryable: true }] }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.entry().phase).toBe("failed");
  expect(f.entry().message).toBe("原构建命令失败");
  expect(f.services.installed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.controller.dispose();
});

it("keeps polling single-flight despite event storms and refuses a second source task", async () => {
  const f = setup();
  let resolve: (run: TaskRun) => void = () => {};
  vi.mocked(f.services.read).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await f.controller.inspect(path);
  const pending = f.controller.convert(path);
  await Promise.resolve(); await Promise.resolve();
  for (let index = 0; index < 100; index++) f.emit();
  await f.controller.inspect("/synthetic/other");
  await f.controller.convert(path);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.services.read).toHaveBeenCalledTimes(1);
  expect(f.services.start).toHaveBeenCalledTimes(1);
  expect(f.services.inspect).toHaveBeenCalledTimes(1);
  resolve(task()); await pending;
  for (let index = 0; index < 100; index++) f.emit();
  expect(f.services.read).toHaveBeenCalledTimes(1);
  await tick(); expect(f.services.read).toHaveBeenCalledTimes(2);
  f.controller.dispose();
});

it("pauses repeated runtime read errors and resumes the same task without starting a duplicate", async () => {
  const f = setup();
  vi.mocked(f.services.runtime).mockRejectedValue(Error("disconnected"));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  await tick(); await tick();
  expect(f.entry().observationError).toContain("disconnected");
  expect(f.controller.snapshot.activePath).toBe(path);
  expect(vi.getTimerCount()).toBe(0);
  vi.mocked(f.services.read).mockResolvedValue(succeeded());
  await f.controller.resume(path);
  expect(f.entry().phase).toBe("succeeded");
  expect(f.services.start).toHaveBeenCalledTimes(1);
  f.controller.dispose();
});

it("unmounts without cancelling an explicitly started background conversion or accepting late reads", async () => {
  const f = setup();
  await f.controller.inspect(path);
  await f.controller.convert(path);
  let resolve: (run: TaskRun) => void = () => {};
  vi.mocked(f.services.read).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await tick();
  const count = f.changed.mock.calls.length;
  f.controller.dispose();
  resolve(succeeded()); await Promise.resolve(); await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.changed).toHaveBeenCalledTimes(count);
  expect(f.services.installed).not.toHaveBeenCalled();
  expect(f.services.cancel).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not wait for event subscription before reading a task and cleans up a late subscription", async () => {
  const f = setup();
  let attach: (stop: () => void) => void = () => {};
  vi.mocked(f.services.listen).mockImplementation(() => new Promise(done => { attach = done; }));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  expect(f.services.read).toHaveBeenCalledTimes(1);
  f.controller.dispose();
  attach(f.stop); await Promise.resolve();
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it("ignores a delayed start response after disposal without cancelling or beginning observation", async () => {
  const f = setup();
  let resolve: (run: TaskRun) => void = () => {};
  vi.mocked(f.services.start).mockImplementation(() => new Promise(done => { resolve = done; }));
  await f.controller.inspect(path);
  const starting = f.controller.convert(path);
  f.controller.dispose(); resolve(task()); await starting;
  expect(f.services.read).not.toHaveBeenCalled();
  expect(f.services.listen).not.toHaveBeenCalled();
  expect(f.services.cancel).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});


it("routes inspection through a durable TaskRun and requires explicit reinspection for conflicting manifests", async () => {
  const f = setup();
  vi.mocked(f.services.inspect).mockImplementation(async (_path, selection) => inspectTask({
    input: { sourcePath: path, ...(selection ? { manifestSelection: selection } : {}) },
    output: inspectionOutput(withManifests(selection ?? "root", true)),
  }));
  await f.controller.inspect(path);
  expect(f.entry().phase).toBe("eligible");
  expect(f.entry().manifestChoiceConfirmed).toBe(false);
  await f.controller.convert(path);
  expect(f.services.start).not.toHaveBeenCalled();
  await f.controller.inspect(path, "public");
  expect(f.entry().manifestChoiceConfirmed).toBe(true);
  expect(f.services.inspect).toHaveBeenNthCalledWith(2, path, "public");
  expect(f.entry().inspection?.manifestSelection).toBe("public");
  f.controller.dispose();
});

it("rejects an explicit selector whose TaskRun output resolves to a different manifest", async () => {
  const f = setup();
  vi.mocked(f.services.inspect).mockResolvedValue(inspectTask({
    input: { sourcePath: path, manifestSelection: "public" }, output: inspectionOutput(withManifests("root", true)),
  }));
  await f.controller.inspect(path, "public");
  expect(f.entry().phase).toBe("failed");
  expect(f.entry().message).toContain("清单与本次选择不一致");
  expect(f.services.start).not.toHaveBeenCalled();
  f.controller.dispose();
});


it("cancels an inspection through its own durable run and waits for terminal state", async () => {
  const f = setup();
  vi.mocked(f.services.inspect).mockResolvedValue(inspectTask({ status: "awaiting_permission", output: null }));
  vi.mocked(f.services.read).mockResolvedValueOnce(inspectTask({ status: "awaiting_permission", output: null }))
    .mockResolvedValue(inspectTask({ status: "cancelled", output: null }));
  vi.mocked(f.services.cancel).mockResolvedValue(inspectTask({ status: "cancelled", output: null }));
  await f.controller.inspect(path);
  expect(f.entry().phase).toBe("awaiting_permission");
  expect(f.entry().taskKind).toBe("inspection");
  await f.controller.cancel(path);
  expect(f.services.cancel).toHaveBeenCalledWith("inspect-run");
  expect(f.entry().phase).toBe("cancelled");
  expect(f.controller.snapshot.activePath).toBeNull();
  expect(f.services.start).not.toHaveBeenCalled();
  f.controller.dispose();
});


it.each([
  { input: { sourcePath: "/foreign/source", manifestSelection: "public" } },
  { input: { sourcePath: path, manifestSelection: "root" } },
])("rejects a durable inspection run for another source or manifest choice: %j", async patch => {
  const f = setup();
  vi.mocked(f.services.inspect).mockResolvedValue(inspectTask({ input: patch.input, output: inspectionOutput(withManifests("public", true)) }));
  await f.controller.inspect(path, "public");
  expect(f.entry().phase).toBe("failed");
  expect(f.entry().message).toContain("检查任务身份");
  expect(f.services.read).not.toHaveBeenCalled();
  expect(f.services.start).not.toHaveBeenCalled();
  f.controller.dispose();
});
