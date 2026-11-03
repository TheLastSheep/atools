import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSourceDependencyController } from "../../src/lib/pluginSourceDependencyController";
import { pluginSourceDependencySession } from "../../src/lib/pluginSourceDependencySession";
import {
  SOURCE_DEPENDENCY_TOOLS, type DependencyAction, type DependencyServices,
  validDependencyFetchResult, validDependencyInspection,
} from "../../src/lib/pluginSourceDependencyProtocol";
import type { TaskRun, TaskRunStatus } from "../../src/lib/types";

const path = "/selected/source";
const rev = "a".repeat(64);
const setId = "b".repeat(64);
const tree = "d".repeat(64);
const nodeHash = "f".repeat(64);
const toolchain = "e".repeat(64);
const inspection = (prepared = false, missingCount = 1, sourceRevision = rev) => ({
  status: "eligible", sourceRevision, planSha256: "c".repeat(64), dependencySetIdSha256: setId,
  target: { os: "darwin", cpu: "arm64" }, packageCount: 2, skippedOptionalCount: 0, cachedBytes: 10,
  missingCount, archiveBytes: null, dependencySetPrepared: prepared,
  dependencyTreeSha256: prepared ? tree : null, dependencyTreeBytes: prepared ? 16 : null,
  nodeBinaryBytes: 1024, nodeBinarySha256: nodeHash, toolchainFingerprintSha256: toolchain,
  toolchainHashElapsedMs: 1, lifecyclesSkipped: true, dependencyClosureVerified: false, businessUsabilityVerified: false,
});
const fetchOutput = (sourceRevision = rev) => ({ status: "cached", sourceRevision, dependencySetIdSha256: setId, packageCount: 2,
  cachedArchiveCount: 1, fetchedArchiveCount: 1, verifiedArchiveBytes: 20, elapsedMs: 3,
  lifecyclesSkipped: true, dependencySetPrepared: false, businessUsabilityVerified: false });
const prepareOutput = (sourceRevision = rev) => ({ status: "prepared", sourceRevision, dependencySetIdSha256: setId,
  manifestSha256: "c".repeat(64), packageCount: 2, archiveBytes: 20, unpackedBytes: 50, fileCount: 2,
  treeSha256: tree, treeEntries: 2, treeFiles: 2, treeBytes: 16, nodeBinaryBytes: 1024,
  nodeBinarySha256: nodeHash, toolchainFingerprintSha256: toolchain, toolchainHashElapsedMs: 1,
  workerElapsedMs: 4, dependencyClosureVerified: false, businessUsabilityVerified: false });

let nextRun = 0;
function run(action: DependencyAction, status: TaskRunStatus, output: unknown, sourcePath = path, expectedRevision?: string): TaskRun {
  return {
    id: `run-${++nextRun}`, capabilityId: SOURCE_DEPENDENCY_TOOLS[action],
    initiator: { type: "human", clientId: "atools-ui" }, status,
    input: expectedRevision === undefined ? { sourcePath } : { sourcePath, expectedRevision }, output,
    summary: null, progress: null, artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: null,
    validation: { status: "not_run" }, createdAt: "now", updatedAt: "now",
  };
}
function harness(make: (action: DependencyAction, sourcePath: string, revision?: string) => TaskRun) {
  const records = new Map<string, TaskRun>();
  const starts: Array<{ action: DependencyAction; sourcePath: string; revision?: string }> = [];
  const cancelled: string[] = [];
  const services: DependencyServices = {
    start: async (action, sourcePath, revision) => {
      starts.push({ action, sourcePath, revision });
      const value = make(action, sourcePath, revision); records.set(value.id, value); return value;
    },
    read: async id => records.get(id) ?? null,
    cancel: async id => { cancelled.push(id); return records.get(id)!; },
    listen: async () => () => {},
  };
  return { services, starts, cancelled, records };
}

describe("PluginSourceDependencyController", () => {
  afterEach(() => pluginSourceDependencySession.resetForTests());

  it("accepts boolean lifecycle metadata when no scripts need skipping, but rejects malformed metadata", () => {
    expect(validDependencyInspection({ ...inspection(), lifecyclesSkipped: false })).toBe(true);
    expect(validDependencyInspection({ ...inspection(), lifecyclesSkipped: "false" })).toBe(false);
    expect(validDependencyFetchResult({ ...fetchOutput(), lifecyclesSkipped: false })).toBe(true);
    expect(validDependencyFetchResult({ ...fetchOutput(), lifecyclesSkipped: null })).toBe(false);
  });

  it("binds TaskRun identity to the selected path and refuses a mismatched start without retrying", async () => {
    const h = harness((action, source, revision) => run(action, "created", null, `${source}-other`, revision));
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect();
    await controller.inspect();
    await controller.recheck();
    expect(h.starts).toHaveLength(1);
    expect(controller.snapshot.activePath).toBe(path);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    expect(controller.snapshot.entry?.canResume).toBe(false);
    controller.dispose();
  });

  it("clears stale dependency state only after terminal inspection and lets the user recheck the new revision", async () => {
    const changedRevision = "9".repeat(64);
    let inspectCount = 0;
    const starts: Array<{ action: DependencyAction; revision?: string }> = [];
    const h = harness((action, source, expectedRevision) => {
      starts.push({ action, revision: expectedRevision });
      if (action === "inspect") {
        inspectCount += 1;
        return run(action, "succeeded", inspection(inspectCount >= 4, 1, inspectCount === 1 ? rev : changedRevision), source, expectedRevision);
      }
      if (action === "fetch") return run(action, "succeeded", fetchOutput(expectedRevision ?? rev), source, expectedRevision);
      return run(action, "succeeded", prepareOutput(expectedRevision ?? rev), source, expectedRevision);
    });
    const onPrepared = vi.fn();
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, onPrepared);

    await controller.inspect(); await controller.fetch(); await controller.prepare();
    expect(controller.snapshot.entry?.phase).toBe("failed");
    expect(onPrepared).not.toHaveBeenCalled();
    expect(controller.snapshot.activePath).toBeNull();
    expect(controller.snapshot.entry?.inspection).toBeUndefined();
    expect(controller.snapshot.entry?.fetchResult).toBeUndefined();
    expect(controller.snapshot.entry?.prepareResult).toBeUndefined();

    await controller.recheck();
    expect(controller.snapshot.entry?.inspection?.sourceRevision).toBe(changedRevision);
    await controller.fetch(); await controller.prepare();
    expect(starts).toEqual([
      { action: "inspect", revision: undefined },
      { action: "fetch", revision: rev },
      { action: "prepare", revision: rev },
      { action: "inspect", revision: undefined },
      { action: "inspect", revision: undefined },
      { action: "fetch", revision: changedRevision },
      { action: "prepare", revision: changedRevision },
      { action: "inspect", revision: undefined },
    ]);
    expect(controller.snapshot.entry?.inspection?.sourceRevision).toBe(changedRevision);
    expect(controller.snapshot.entry?.phase).toBe("eligible");
    expect(onPrepared).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("keeps the gate closed when task creation returns no usable identity", async () => {
    const h = harness((action, source, revision) => run(action, "created", null, source, revision));
    h.services.start = async (action, source, revision) => {
      h.starts.push({ action, sourcePath: source, revision });
      return null as unknown as TaskRun;
    };
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect();
    await controller.inspect();
    await controller.recheck();
    expect(h.starts).toHaveLength(1);
    expect(controller.snapshot.activePath).toBe(path);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    expect(controller.snapshot.entry?.canResume).toBe(false);
    controller.dispose();
  });

  it("allows a terminal failed fetch to recheck and use only the new source revision", async () => {
    const changedRevision = "8".repeat(64);
    let inspections = 0;
    const h = harness((action, source, expectedRevision) => {
      if (action === "inspect") {
        inspections += 1;
        return run(action, "succeeded", inspection(false, 1, inspections === 1 ? rev : changedRevision), source, expectedRevision);
      }
      if (action === "fetch" && expectedRevision === rev) {
        const failed = run(action, "failed", null, source, expectedRevision);
        failed.errors = [{ code: "SOURCE_DEPENDENCY_SOURCE_CHANGED", message: "fixed" }] as TaskRun["errors"];
        return failed;
      }
      return run(action, "succeeded", fetchOutput(changedRevision), source, expectedRevision);
    });
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});

    await controller.inspect(); await controller.fetch();
    expect(controller.snapshot.entry?.phase).toBe("failed");
    expect(controller.snapshot.activePath).toBeNull();

    await controller.recheck();
    expect(controller.snapshot.entry?.inspection?.sourceRevision).toBe(changedRevision);
    await controller.fetch();
    expect(h.starts.map(value => [value.action, value.revision])).toEqual([
      ["inspect", undefined], ["fetch", rev], ["inspect", undefined], ["fetch", changedRevision],
    ]);
    expect(controller.snapshot.entry?.fetchResult?.sourceRevision).toBe(changedRevision);
    controller.dispose();
  });

  it("does not start duplicate inspection requests while start_agent_tool is pending", async () => {
    let resolveStart!: (value: TaskRun) => void;
    const h = harness((action, source, revision) => run(action, "succeeded", inspection(), source, revision));
    h.services.start = (action, source, revision) => {
      h.starts.push({ action, sourcePath: source, revision });
      return new Promise(resolve => {
        resolveStart = value => { h.records.set(value.id, value); resolve(value); };
      });
    };
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    const first = controller.inspect();
    const duplicate = controller.inspect();
    await controller.recheck();
    const durableRun = run("inspect", "succeeded", inspection());
    resolveStart(durableRun);
    await Promise.all([first, duplicate]);
    expect(h.starts).toHaveLength(1);
    expect(controller.snapshot.entry?.inspection?.sourceRevision).toBe(rev);
    controller.dispose();
  });

  it("permits a user retry after permission denial and downloads even when missingCount is zero", async () => {
    let number = 0;
    const h = harness((action, source, revision) => {
      number += 1;
      if (number === 1) {
        const denied = run(action, "cancelled", null, source, revision);
        denied.summary = "Permission request was dismissed";
        return denied;
      }
      return run(action, "succeeded", action === "inspect" ? inspection(false, 0) : fetchOutput(), source, revision);
    });
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect();
    expect(controller.snapshot.entry?.phase).toBe("cancelled");
    await controller.retry();
    expect(controller.snapshot.entry?.inspection?.sourceRevision).toBe(rev);
    await controller.fetch();
    expect(h.starts.map(value => value.action)).toEqual(["inspect", "inspect", "fetch"]);
    expect(controller.snapshot.entry?.fetchResult?.verifiedArchiveBytes).toBe(20);
    controller.dispose();
  });

  it("does not prepare when the download task failed", async () => {
    const h = harness((action, source, revision) => {
      if (action === "inspect") return run(action, "succeeded", inspection(), source, revision);
      if (action === "fetch") return run(action, "failed", null, source, revision);
      return run(action, "succeeded", prepareOutput(), source, revision);
    });
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect();
    await controller.fetch();
    await controller.prepare();
    expect(h.starts.map(value => value.action)).toEqual(["inspect", "fetch"]);
    expect(controller.snapshot.entry?.phase).toBe("failed");
    controller.dispose();
  });

  it("blocks the next action on an unknown success output", async () => {
    const h = harness((action, source, revision) => action === "inspect"
      ? run(action, "succeeded", inspection(), source, revision)
      : run(action, "succeeded", { ...fetchOutput(), privateExtra: true }, source, revision));
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect(); await controller.fetch(); await controller.prepare();
    expect(h.starts.map(value => value.action)).toEqual(["inspect", "fetch"]);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    expect(controller.snapshot.activePath).toBe(path);
    controller.dispose();
  });

  it("checks source revision and dependency-set identity before accepting downloaded archives", async () => {
    const h = harness((action, source, revision) => {
      if (action === "inspect") return run(action, "succeeded", inspection(false, 0), source, revision);
      const wrong = { ...fetchOutput(), sourceRevision: "c".repeat(64) };
      return run(action, "succeeded", wrong, source, revision);
    });
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect(); await controller.fetch(); await controller.prepare();
    expect(h.starts.map(value => value.action)).toEqual(["inspect", "fetch"]);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    controller.dispose();
  });

  it("rejects dependency-closure or business-usability claims even when their flags are true", async () => {
    const suspicious = { ...inspection(), dependencyClosureVerified: true, businessUsabilityVerified: true };
    expect(validDependencyInspection(suspicious)).toBe(false);
    const h = harness((action, source, revision) => run(action, "succeeded", suspicious, source, revision));
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect(); await controller.fetch();
    expect(h.starts.map(value => value.action)).toEqual(["inspect"]);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    controller.dispose();
  });

  it("rejects a downloaded result from a different dependency set", async () => {
    const h = harness((action, source, revision) => {
      if (action === "inspect") return run(action, "succeeded", inspection(), source, revision);
      return run(action, "succeeded", { ...fetchOutput(), dependencySetIdSha256: "c".repeat(64) }, source, revision);
    });
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect(); await controller.fetch(); await controller.prepare();
    expect(h.starts.map(value => value.action)).toEqual(["inspect", "fetch"]);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    controller.dispose();
  });

  it("rejects a TaskRun bound to a different expected revision", async () => {
    const h = harness((action, source, revision) => action === "inspect"
      ? run(action, "succeeded", inspection(), source, revision)
      : run(action, "succeeded", fetchOutput(), source, "c".repeat(64)));
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect(); await controller.fetch(); await controller.prepare();
    expect(h.starts.map(value => value.action)).toEqual(["inspect", "fetch"]);
    expect(controller.snapshot.entry?.phase).toBe("observing");
    controller.dispose();
  });

  it("cancels by TaskRun id, stays cancelling while still running, and never reports completion", async () => {
    let current!: TaskRun;
    const h = harness((action, source, revision) => {
      current = run(action, "running", null, source, revision); return current;
    });
    h.services.cancel = async id => { h.cancelled.push(id); return current; };
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    await controller.inspect();
    await controller.cancel();
    expect(h.cancelled).toEqual([current.id]);
    expect(controller.snapshot.entry?.phase).toBe("cancelling");
    expect(controller.snapshot.entry?.taskStatus).toBe("running");
    controller.dispose();
  });

  it("prepares, rechecks the prepared set, then refreshes source conversion without auto-converting", async () => {
    const sequence: DependencyAction[] = ["inspect", "fetch", "prepare", "inspect"];
    let n = 0;
    const h = harness((action, source, revision) => {
      const expected = sequence[n++];
      expect(action).toBe(expected);
      const output = action === "inspect" ? inspection(n > 1) : action === "fetch" ? fetchOutput() : prepareOutput();
      return run(action, "succeeded", output, source, revision);
    });
    const onPrepared = vi.fn();
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, onPrepared);
    await controller.inspect(); await controller.fetch(); await controller.prepare();
    expect(h.starts.map(value => value.action)).toEqual(sequence);
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.entry?.inspection?.dependencySetPrepared).toBe(true);
    expect(controller.snapshot.entry?.phase).toBe("eligible");
    controller.dispose();
  });

  it("does not cancel work on dispose and does not create another task after read timeout", async () => {
    vi.useFakeTimers();
    const h = harness((action, source, revision) => run(action, "running", null, source, revision));
    h.services.read = async () => { throw Error("timeout"); };
    const controller = new PluginSourceDependencyController(path, h.services, () => {}, () => {});
    const first = controller.inspect();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await first;
    expect(controller.snapshot.entry?.phase).toBe("observing");
    await controller.recheck();
    expect(h.starts).toHaveLength(1);
    await controller.resume();
    expect(h.starts).toHaveLength(1);
    controller.dispose();
    expect(h.cancelled).toHaveLength(0);
    vi.useRealTimers();
  });
});
