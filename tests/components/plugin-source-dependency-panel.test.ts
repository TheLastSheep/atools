import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ZToolsImportPanel from "../../src/components/ZToolsImportPanel.svelte";
import { SOURCE_DEPENDENCY_TOOLS } from "../../src/lib/pluginSourceDependencyProtocol";
import { SOURCE_BUILD_INSPECT_TOOL } from "../../src/lib/pluginSourceBuildProtocol";
import { pluginSourceDependencySession } from "../../src/lib/pluginSourceDependencySession";
import type { TaskRun, ZToolsImportCandidate } from "../../src/lib/types";
import { ztoolsImportSelectionSession } from "../../src/lib/ztoolsImportSelectionSession";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const sourceA = "/selected/source-a";
const sourceB = "/selected/source-b";
const revision = "a".repeat(64);
const candidates: ZToolsImportCandidate[] = [
  { path: sourceA, source_type: "directory", entry_readiness: "requires_build", name: "source-a", title: "源码 A", version: "1.0.0", features_count: 1,
    platform_supported: true, main_exists: false, preload_exists: true, logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [] },
  { path: sourceB, source_type: "directory", entry_readiness: "requires_build", name: "source-b", title: "源码 B", version: "1.0.0", features_count: 1,
    platform_supported: true, main_exists: false, preload_exists: true, logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [] },
  { path: "/selected/ready-plugin", source_type: "directory", entry_readiness: "ready", name: "ready-plugin", title: "可导入插件", version: "1.0.0", features_count: 1,
    platform_supported: true, main_exists: true, preload_exists: true, logo_exists: true, unsupported_cmd_types: [], warnings: [], errors: [] },
];
let runs: Map<string, TaskRun>;
let nextRun: number;
let unavailableReads: number;
let stop: ReturnType<typeof vi.fn>;

function row(path: string): HTMLElement {
  const text = screen.getByText(path);
  return text.closest(".candidate-row") as HTMLElement;
}
function taskRun(name: string, input: Record<string, unknown>, status: TaskRun["status"]): TaskRun {
  return {
    id: `dependency-run-${++nextRun}`, capabilityId: name,
    initiator: { type: "human", clientId: "atools-ui" }, input, status, output: null,
    summary: null, progress: null, artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: null,
    validation: { status: "not_run" }, createdAt: "now", updatedAt: "now",
  } as TaskRun;
}
function sourceBuildInspectionTask(input: Record<string, unknown>): TaskRun {
  const run = taskRun(SOURCE_BUILD_INSPECT_TOOL, input, "succeeded");
  run.output = { status: "blocked", blockers: [{ code: "dependencies_missing", message: "请先准备构建依赖。" }], sourceRevision: revision };
  runs.set(run.id, run);
  return run;
}
function startTask(name: string, input: Record<string, unknown>, status: TaskRun["status"] = "running"): TaskRun {
  const run = taskRun(name, input, status);
  runs.set(run.id, run);
  return run;
}
function started(name: string) {
  return mocks.invoke.mock.calls.filter(([command, args]) => command === "start_agent_tool" && args?.name === name);
}

beforeEach(() => {
  runs = new Map(); nextRun = 0; unavailableReads = 0; stop = vi.fn();
  ztoolsImportSelectionSession.clear();
  mocks.invoke.mockReset(); mocks.open.mockReset(); mocks.listen.mockReset();
  mocks.listen.mockImplementation(async () => stop);
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "scan_default_ztools_plugins") return candidates;
    if (command === "start_agent_tool") {
      const name = String(args.name);
      const input = args.arguments as Record<string, unknown>;
      return name === SOURCE_BUILD_INSPECT_TOOL ? sourceBuildInspectionTask(input) : startTask(name, input);
    }
    if (command === "get_task_run") {
      if (unavailableReads > 0) { unavailableReads -= 1; return null; }
      return runs.get(String(args.id)) ?? null;
    }
    if (command === "cancel_task_run") return runs.get(String(args.id)) ?? null;
    if (command === "list_plugins") return [];
    return undefined;
  });
});
afterEach(() => { cleanup(); ztoolsImportSelectionSession.clear(); pluginSourceDependencySession.resetForTests(); });

describe("dependency busy gate in the import panel", () => {
  it("keeps one operation lease until its matching TaskRun reaches terminal", () => {
    const origin = {};
    const entry = { sourcePath: sourceA, phase: "starting" as const, message: "", error: "" };
    const operationId = pluginSourceDependencySession.begin(sourceA, entry, origin)!;
    const identity = { id: "dependency-run", action: "inspect" as const, sourcePath: sourceA };
    expect(pluginSourceDependencySession.activePath()).toBe(sourceA);
    expect(pluginSourceDependencySession.clearInactiveForNewState()).toBe(false);
    expect(pluginSourceDependencySession.begin(sourceB, { ...entry, sourcePath: sourceB }, {})).toBeUndefined();
    expect(pluginSourceDependencySession.setIdentity(operationId, identity,
      { ...entry, phase: "running", runId: identity.id, taskStatus: "running" }, origin, origin)).toBe(true);
    expect(pluginSourceDependencySession.releaseTerminal(operationId, { ...identity, id: "other" }, entry, origin)).toBe(false);
    expect(pluginSourceDependencySession.activePath()).toBe(sourceA);
    expect(pluginSourceDependencySession.releaseTerminal(operationId, identity,
      { ...entry, phase: "succeeded", runId: identity.id, taskStatus: "succeeded" }, origin)).toBe(true);
    expect(pluginSourceDependencySession.activePath()).toBeNull();
    expect(pluginSourceDependencySession.snapshot(sourceA)?.active).toBe(false);
    expect(pluginSourceDependencySession.sessionPath()).toBe(sourceA);
    expect(pluginSourceDependencySession.clearInactiveForNewState()).toBe(true);
    expect(pluginSourceDependencySession.sessionPath()).toBeNull();
    expect(pluginSourceDependencySession.begin(sourceB, { ...entry, sourcePath: sourceB }, {})).toBeDefined();
  });

  it("locks other rows and global actions while the selected task runs, keeps same-row cancel, and only stops observing on unmount", async () => {
    const view = render(ZToolsImportPanel);
    await screen.findByRole("button", { name: "导入 1 个插件" });
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查可转换版本" }));
    await screen.findByText("请先准备构建依赖。");
    await fireEvent.click(within(row(sourceB)).getByRole("button", { name: "检查可转换版本" }));
    await within(row(sourceB)).findByText("请先准备构建依赖。");

    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查依赖" }));
    await within(row(sourceA)).findByRole("button", { name: "取消依赖任务" });
    expect((within(row(sourceA)).getByRole("button", { name: "取消依赖任务" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(row(sourceB)).getByRole("button", { name: "检查依赖" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(row(sourceB)).getByRole("button", { name: "重新检查转换" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "扫描 ZTools" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "选择目录" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "选择插件包" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "导入 1 个插件" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /可导入插件/ }) as HTMLInputElement).disabled).toBe(true);
    view.unmount();
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run")).toHaveLength(0);
    expect([...runs.values()].map(({ id, capabilityId, status }) => ({ id, capabilityId, status })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([
        { id: "dependency-run-1", capabilityId: SOURCE_BUILD_INSPECT_TOOL, status: "succeeded" },
        { id: "dependency-run-2", capabilityId: SOURCE_BUILD_INSPECT_TOOL, status: "succeeded" },
        { id: "dependency-run-3", capabilityId: SOURCE_DEPENDENCY_TOOLS.inspect, status: "running" },
      ]);
  });

  it("reattaches the same TaskRun after panel remount and releases other rows only after its matching terminal read", async () => {
    let heldRunId: string | undefined;
    let releaseRead: ((value: TaskRun | null) => void) | undefined;
    const starts: Array<{ name: string; sourcePath: string }> = [];
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "scan_default_ztools_plugins") return candidates;
      if (command === "start_agent_tool") {
        const name = String(args.name);
        const input = args.arguments as Record<string, unknown>;
        if (name === SOURCE_BUILD_INSPECT_TOOL) return sourceBuildInspectionTask(input);
        starts.push({ name, sourcePath: String(input.sourcePath) });
        return startTask(name, input);
      }
      if (command === "get_task_run") {
        const id = String(args.id);
        if (id === heldRunId) return new Promise<TaskRun | null>(resolve => { releaseRead = resolve; });
        return runs.get(id) ?? null;
      }
      if (command === "cancel_task_run") return runs.get(String(args.id)) ?? null;
      if (command === "list_plugins") return [];
      return undefined;
    });

    let view = render(ZToolsImportPanel);
    await screen.findByText(sourceA);
    for (const source of [sourceA, sourceB]) {
      await fireEvent.click(within(row(source)).getByRole("button", { name: "检查可转换版本" }));
      await within(row(source)).findByText("请先准备构建依赖。");
    }
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查依赖" }));
    await within(row(sourceA)).findByRole("button", { name: "取消依赖任务" });
    const taskId = [...runs.values()].find(run => run.capabilityId === SOURCE_DEPENDENCY_TOOLS.inspect)?.id;
    expect(taskId).toBeTruthy();
    view.unmount();
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "cancel_task_run")).toHaveLength(0);

    const terminal = runs.get(taskId!)!;
    terminal.status = "succeeded";
    terminal.output = {
      status: "eligible", sourceRevision: revision, planSha256: "c".repeat(64), dependencySetIdSha256: "b".repeat(64),
      target: { os: "darwin", cpu: "arm64" }, packageCount: 2, skippedOptionalCount: 0, cachedBytes: 0,
      missingCount: 1, archiveBytes: null, dependencySetPrepared: false, dependencyTreeSha256: null,
      dependencyTreeBytes: null, nodeBinaryBytes: 1024, nodeBinarySha256: "f".repeat(64),
      toolchainFingerprintSha256: "e".repeat(64), toolchainHashElapsedMs: 1, lifecyclesSkipped: false,
      dependencyClosureVerified: false, businessUsabilityVerified: false,
    };
    heldRunId = taskId;
    view = render(ZToolsImportPanel);
    await screen.findByText(sourceA);
    await within(row(sourceA)).findByText("依赖任务正在运行…");
    await within(row(sourceA)).findByRole("button", { name: "取消依赖任务" });
    await waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    expect(started(SOURCE_DEPENDENCY_TOOLS.inspect)).toHaveLength(1);
    expect(started(SOURCE_BUILD_INSPECT_TOOL)).toHaveLength(2);
    expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "get_task_run" && args.id === taskId)).toHaveLength(2);
    expect(within(row(sourceA)).queryByRole("button", { name: "检查可转换版本" })).toBeNull();
    expect((within(row(sourceB)).getByRole("button", { name: "检查可转换版本" }) as HTMLButtonElement).disabled).toBe(true);

    releaseRead!(terminal);
    await within(row(sourceA)).findByRole("button", { name: "下载构建依赖" });
    expect((screen.getByRole("button", { name: "扫描 ZTools" }) as HTMLButtonElement).disabled).toBe(false);
    expect(pluginSourceDependencySession.sessionPath()).toBe(sourceA);
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查可转换版本" }));
    await within(row(sourceA)).findByText("请先准备构建依赖。");
    expect(pluginSourceDependencySession.sessionPath()).toBeNull();
    expect(within(row(sourceA)).queryByText(/已校验下载/)).toBeNull();
    await waitFor(() => expect((within(row(sourceB)).getByRole("button", { name: "检查可转换版本" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(within(row(sourceB)).getByRole("button", { name: "检查可转换版本" }));
    await within(row(sourceB)).findByText("请先准备构建依赖。");
    await fireEvent.click(within(row(sourceB)).getByRole("button", { name: "检查依赖" }));
    await within(row(sourceB)).findByRole("button", { name: "取消依赖任务" });
    expect(starts).toEqual([
      { name: SOURCE_DEPENDENCY_TOOLS.inspect, sourcePath: sourceA },
      { name: SOURCE_DEPENDENCY_TOOLS.inspect, sourcePath: sourceB },
    ]);
    view.unmount();
  });

  it("keeps an unknown-start lease fail-closed across panel close and reopen", async () => {
    const starts: Array<{ name: string; sourcePath: string }> = [];
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "scan_default_ztools_plugins") return candidates;
      if (command === "start_agent_tool") {
        const name = String(args.name);
        const input = args.arguments as Record<string, unknown>;
        if (name === SOURCE_BUILD_INSPECT_TOOL) return sourceBuildInspectionTask(input);
        starts.push({ name, sourcePath: String(input.sourcePath) });
        return { ...startTask(name, input, "created"), id: "" };
      }
      if (command === "list_plugins") return [];
      return undefined;
    });

    let view = render(ZToolsImportPanel);
    await screen.findByText(sourceA);
    for (const source of [sourceA, sourceB]) {
      await fireEvent.click(within(row(source)).getByRole("button", { name: "检查可转换版本" }));
      await within(row(source)).findByText("请先准备构建依赖。");
    }
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查依赖" }));
    await within(row(sourceA)).findByText(/无法确认依赖任务是否创建成功/);
    view.unmount();

    view = render(ZToolsImportPanel);
    await screen.findByText(sourceA);
    await within(row(sourceA)).findByText(/无法确认依赖任务是否创建成功/);
    expect((within(row(sourceB)).getByRole("button", { name: "检查可转换版本" }) as HTMLButtonElement).disabled).toBe(true);
    expect(started(SOURCE_DEPENDENCY_TOOLS.inspect)).toHaveLength(1);
    expect(starts).toEqual([{ name: SOURCE_DEPENDENCY_TOOLS.inspect, sourcePath: sourceA }]);
    view.unmount();
  });

  it("lets a terminal source-changed fetch recheck from the panel before retrying with the new revision", async () => {
    const changedRevision = "9".repeat(64);
    const starts: Array<{ name: string; sourcePath: string; expectedRevision?: string }> = [];
    let inspectCount = 0;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "scan_default_ztools_plugins") return candidates;
      if (command === "start_agent_tool") {
        const name = String(args.name);
        const input = args.arguments as Record<string, unknown>;
        if (name === SOURCE_BUILD_INSPECT_TOOL) return sourceBuildInspectionTask(input);
        starts.push({ name, sourcePath: String(input.sourcePath), expectedRevision: input.expectedRevision as string | undefined });
        const isInspect = name === SOURCE_DEPENDENCY_TOOLS.inspect;
        const isFetch = name === SOURCE_DEPENDENCY_TOOLS.fetch;
        const resultRevision = isInspect
          ? (++inspectCount === 1 ? revision : changedRevision)
          : String(input.expectedRevision);
        const output = isInspect ? {
          status: "eligible", sourceRevision: resultRevision, planSha256: "c".repeat(64),
          dependencySetIdSha256: "b".repeat(64), target: { os: "darwin", cpu: "arm64" },
          packageCount: 2, skippedOptionalCount: 0, cachedBytes: 0, missingCount: 1, archiveBytes: null,
          dependencySetPrepared: false, dependencyTreeSha256: null, dependencyTreeBytes: null,
          nodeBinaryBytes: 1024, nodeBinarySha256: "f".repeat(64), toolchainFingerprintSha256: "e".repeat(64),
          toolchainHashElapsedMs: 1, lifecyclesSkipped: false, dependencyClosureVerified: false, businessUsabilityVerified: false,
        } : {
          status: "cached", sourceRevision: resultRevision, dependencySetIdSha256: "b".repeat(64),
          packageCount: 2, cachedArchiveCount: 1, fetchedArchiveCount: 0, verifiedArchiveBytes: 20,
          elapsedMs: 2, lifecyclesSkipped: false, dependencySetPrepared: false, businessUsabilityVerified: false,
        };
        const run = taskRun(name, input, isFetch && resultRevision === revision ? "failed" : "succeeded");
        run.output = isFetch && resultRevision === revision ? null : output;
        if (isFetch && resultRevision === revision) {
          run.errors = [{ code: "SOURCE_DEPENDENCY_SOURCE_CHANGED", message: "fixed" }] as TaskRun["errors"];
        }
        runs.set(run.id, run);
        return run;
      }
      if (command === "get_task_run") return runs.get(String(args.id)) ?? null;
      if (command === "cancel_task_run") return runs.get(String(args.id)) ?? null;
      if (command === "list_plugins") return [];
      return undefined;
    });

    render(ZToolsImportPanel);
    await screen.findByText(sourceA);
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查可转换版本" }));
    await screen.findByText("请先准备构建依赖。");
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查依赖" }));
    await within(row(sourceA)).findByRole("button", { name: "下载构建依赖" });
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "下载构建依赖" }));
    await within(row(sourceA)).findByRole("button", { name: "重新检查源码" });
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "重新检查源码" }));
    await within(row(sourceA)).findByRole("button", { name: "下载构建依赖" });
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "下载构建依赖" }));
    await within(row(sourceA)).findByText(/已校验下载/);

    expect(starts.map(item => [item.name, item.expectedRevision])).toEqual([
      [SOURCE_DEPENDENCY_TOOLS.inspect, undefined],
      [SOURCE_DEPENDENCY_TOOLS.fetch, revision],
      [SOURCE_DEPENDENCY_TOOLS.inspect, undefined],
      [SOURCE_DEPENDENCY_TOOLS.fetch, changedRevision],
    ]);
  });

  it("keeps same-row resume available after an observation failure without starting a second task", async () => {
    unavailableReads = 1;
    render(ZToolsImportPanel);
    await screen.findByText(sourceA);
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查可转换版本" }));
    await screen.findByText("请先准备构建依赖。");
    await fireEvent.click(within(row(sourceA)).getByRole("button", { name: "检查依赖" }));
    const resume = await within(row(sourceA)).findByRole("button", { name: "继续读取任务" });
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    expect(started(SOURCE_DEPENDENCY_TOOLS.inspect)).toHaveLength(1);
    await fireEvent.click(resume);
    await within(row(sourceA)).findByText("依赖任务正在运行…");
    expect(started(SOURCE_DEPENDENCY_TOOLS.inspect)).toHaveLength(1);
    expect(started(SOURCE_BUILD_INSPECT_TOOL)).toHaveLength(1);
    expect((within(row(sourceA)).getByRole("button", { name: "取消依赖任务" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
