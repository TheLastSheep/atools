import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginSourceBuildController } from "../../src/lib/pluginSourceBuildController";
import { pluginSourceBuildServices } from "../../src/lib/pluginSourceBuildServices";
import type { SourceBuildInspection, SourceBuildRuntime } from "../../src/lib/pluginSourceBuildProtocol";
import type { TaskRun } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const path = "/synthetic/source-plugin";
const revision = "a".repeat(64);
const inspection: SourceBuildInspection = { status: "eligible", pluginId: "source-plugin", version: "1.0.0", blockers: [], sourceRevision: revision };
const runtime: SourceBuildRuntime = { active: true, stage: "building", cancellable: true, cancelRequested: false };
const inspectRun = (status: TaskRun["status"] = "succeeded", output: SourceBuildInspection | null = inspection): TaskRun => ({
  id: "inspect-1", capabilityId: "inspect_ztools_source_build", initiator: { type: "human", clientId: "atools-ui" }, status,
  input: { sourcePath: path }, output,
} as TaskRun);
const run = (status: TaskRun["status"] = "running"): TaskRun => ({
  id: "run-1", capabilityId: "convert_ztools_plugin", initiator: { type: "human", clientId: "atools-ui" }, status,
  input: { sourcePath: path, expectedRevision: revision, overwrite: true },
  output: { installed: true, pluginId: "source-plugin", version: "1.0.0", sourceRevision: revision },
} as TaskRun);
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const controllers: PluginSourceBuildController[] = [];
function setup() {
  const installed = vi.fn(async () => {});
  const changed = vi.fn();
  const controller = new PluginSourceBuildController(pluginSourceBuildServices(installed), changed);
  controllers.push(controller);
  return { controller, installed, changed, entry: () => controller.snapshot.entries[path] };
}
beforeEach(() => {
  vi.useFakeTimers(); mocks.invoke.mockReset(); mocks.listen.mockReset();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") return inspectRun();
    if (command === "start_agent_tool" || command === "get_task_run" || command === "cancel_task_run") return run();
    if (command === "get_plugin_source_build_state") return runtime;
  });
});
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });

it("pauses a stalled inspection task read, resumes it and ignores late stale answers", async () => {
  const f = setup();
  const stale: ReturnType<typeof deferred<TaskRun>>[] = [];
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") return Promise.resolve(inspectRun("running", null));
    if (command === "get_task_run" && args?.id === "inspect-1") {
      const read = deferred<TaskRun>();
      stale.push(read);
      return read.promise;
    }
    return base(command, args);
  });
  const pending = f.controller.inspect(path);
  await vi.advanceTimersByTimeAsync(15_500);
  expect(stale.length).toBeGreaterThan(0);
  expect(f.entry().observationError).toContain("超时");
  expect(f.controller.snapshot.activePath).toBe(path);
  mocks.invoke.mockImplementation((command, args) =>
    command === "get_task_run" && args?.id === "inspect-1" ? Promise.resolve(inspectRun("succeeded", inspection)) : base(command, args));
  await f.controller.resume(path);
  await pending;
  expect(f.entry().phase).toBe("eligible");
  expect(f.controller.snapshot.activePath).toBeNull();

  const staleAnswer: SourceBuildInspection = { status: "blocked", blockers: [{ code: "STALE", message: "stale answer" }] };
  stale.forEach(read => read.resolve(inspectRun("succeeded", staleAnswer)));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.entry().phase).toBe("eligible");
  expect(f.entry().message ?? "").not.toContain("stale answer");
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "inspect_ztools_source_build")).toHaveLength(1);
});

it.each(["get_task_run", "get_plugin_source_build_state"])("pauses never-settling %s reads, ignores late answers and resumes the same run", async stalledCommand => {
  const f = setup();
  const late = [deferred<TaskRun | SourceBuildRuntime>(), deferred<TaskRun | SourceBuildRuntime>(), deferred<TaskRun | SourceBuildRuntime>()];
  let staleReads = 0;
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === stalledCommand ? late[staleReads++].promise : base(command, args));
  await f.controller.inspect(path);
  const started = f.controller.convert(path);
  await vi.advanceTimersByTimeAsync(15_500);
  expect(f.entry().observationError).toContain("超时");
  expect(f.entry().phase).not.toBe("succeeded");
  expect(f.controller.snapshot.activePath).toBe(path);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === stalledCommand)).toHaveLength(3);
  expect(vi.getTimerCount()).toBe(0);
  const beforeLate = f.changed.mock.calls.length;
  const staleReply = stalledCommand === "get_task_run" ? run("succeeded") : { ...runtime, stage: "installing" as const, cancellable: false };
  late[0].resolve(staleReply);
  await Promise.resolve(); await Promise.resolve();
  expect(f.changed).toHaveBeenCalledTimes(beforeLate);
  expect(f.installed).not.toHaveBeenCalled();
  mocks.invoke.mockImplementation(base);
  await f.controller.resume(path);
  expect(f.entry().phase).toBe("building");
  const afterResume = f.changed.mock.calls.length;
  late[1].resolve(staleReply); late[2].resolve(staleReply);
  await Promise.resolve(); await Promise.resolve();
  expect(f.changed).toHaveBeenCalledTimes(afterResume);
  expect(f.entry().phase).toBe("building");
  mocks.invoke.mockImplementation((command, args) => command === "get_task_run" ? Promise.resolve(run("succeeded")) : base(command, args));
  await vi.advanceTimersByTimeAsync(250);
  await started;
  expect(f.entry().phase).toBe("succeeded");
  expect(f.installed).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "convert_ztools_plugin")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run")).toHaveLength(0);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "get_task_run").every(([, args]) => args.id === "run-1")).toBe(true);
});

it("keeps the original pending start request without a timeout or duplicate job", async () => {
  const f = setup();
  const late = deferred<TaskRun>();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) =>
    command === "start_agent_tool" && args?.name === "convert_ztools_plugin" ? late.promise : base(command, args));
  await f.controller.inspect(path);
  const pending = f.controller.convert(path);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.entry().phase).toBe("starting");
  expect(f.controller.snapshot.activePath).toBe(path);
  await f.controller.convert(path);
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === "convert_ztools_plugin")).toHaveLength(1);
  late.resolve(run()); await pending;
  expect(f.entry().phase).toBe("building");
});

it("does not assume cancellation succeeded when the cancel request never returns", async () => {
  const f = setup();
  const late = deferred<TaskRun>();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "cancel_task_run" ? late.promise : base(command, args));
  await f.controller.inspect(path);
  await f.controller.convert(path);
  const cancelling = f.controller.cancel(path);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.entry().phase).toBe("building");
  expect(f.controller.snapshot.activePath).toBe(path);
  await f.controller.cancel(path);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run")).toHaveLength(1);
  expect(f.installed).not.toHaveBeenCalled();
  f.controller.dispose(); late.resolve(run()); await cancelling;
});

it("lets a new run cancel after the old run terminates despite an unanswered old cancel request", async () => {
  const f = setup();
  const firstCancel = deferred<TaskRun>();
  const secondCancel = deferred<TaskRun>();
  const base = mocks.invoke.getMockImplementation()!;
  let current = run();
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "cancel_task_run") return args.id === "run-1" ? firstCancel.promise : secondCancel.promise;
    if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") return Promise.resolve(inspectRun());
    if (command === "start_agent_tool" || command === "get_task_run") return Promise.resolve(current);
    return base(command, args);
  });
  await f.controller.inspect(path); await f.controller.convert(path);
  const first = f.controller.cancel(path);
  current = run("cancelled");
  await vi.advanceTimersByTimeAsync(250);
  expect(f.entry().phase).toBe("cancelled");
  current = { ...run(), id: "run-2" };
  await f.controller.inspect(path); await f.controller.convert(path);
  const second = f.controller.cancel(path);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run").map(([, args]) => args.id)).toEqual(["run-1", "run-2"]);
  f.controller.dispose();
  firstCancel.resolve(run()); secondCancel.resolve(current); await Promise.all([first, second]);
});

it.each(["inspect_ztools_source_build", "get_task_run", "get_plugin_source_build_state"])("clears the %s deadline immediately on disposal and ignores late native success", async stalledCommand => {
  const f = setup();
  const late = deferred<TaskRun | SourceBuildRuntime | SourceBuildInspection>();
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => {
    if (stalledCommand === "inspect_ztools_source_build") {
      if (command === "start_agent_tool" && args?.name === "inspect_ztools_source_build") return Promise.resolve(inspectRun("running", null));
      if (command === "get_task_run" && args?.id === "inspect-1") return late.promise;
    }
    if (command === stalledCommand) return late.promise;
    return base(command, args);
  });
  const checking = f.controller.inspect(path);
  if (stalledCommand !== "inspect_ztools_source_build") await checking;
  const pending = stalledCommand === "inspect_ztools_source_build" ? checking : f.controller.convert(path);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.getTimerCount()).toBe(1);
  const published = f.changed.mock.calls.length;
  f.controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  late.resolve(stalledCommand === "inspect_ztools_source_build" ? inspectRun("succeeded", inspection) : stalledCommand === "get_task_run" ? run("succeeded") : runtime);
  await pending;
  expect(f.changed).toHaveBeenCalledTimes(published);
  expect(f.installed).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run")).toHaveLength(0);
});
