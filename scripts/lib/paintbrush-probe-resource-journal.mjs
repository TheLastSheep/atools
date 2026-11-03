import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function processSnapshot() {
  const { stdout } = await execFileAsync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart=,comm="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2500, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      start: match[4].trim(), command: match[5].trim() }] : [];
  });
}

export async function observeOwnedProcessGroup(pid, phase, expectedIdentity = null) {
  try {
    const rows = await processSnapshot();
    const leader = rows.find((row) => row.pid === pid) || null;
    if (phase === "before-stop") {
      const identity = leader ? `${leader.pgid}:${leader.start}:${leader.command}` : null;
      return { status: leader ? "observed" : "leader-absent", pid, pgid: leader?.pgid ?? null,
        identity, leaderMatchesProcessGroup: leader?.pgid === pid };
    }
    const matchingGroup = rows.filter((row) => row.pgid === pid);
    const identity = leader ? `${leader.pgid}:${leader.start}:${leader.command}` : null;
    return { status: "observed", pid, pgid: pid, groupMemberCount: matchingGroup.length,
      remainingMembers: matchingGroup.map((row) => ({ pid: row.pid, command: row.command })),
      leaderIdentityPresent: identity !== null && identity === expectedIdentity,
      leaderPresent: leader !== null, observedGroupEmpty: matchingGroup.length === 0 };
  } catch (error) {
    return { status: "unknown", errorCode: String(error?.code || error?.name || "Error").slice(0, 80) };
  }
}

/** Crash-recovery metadata for this one headless fixture run; never stores endpoint tokens or image data. */
export class PaintbrushProbeResourceJournal {
  constructor(path, runId) {
    this.path = path;
    this.runId = runId;
    this.sequence = 0;
    this.createdAt = new Date().toISOString();
    this.record = {
      schemaVersion: 1, runId, createdAt: this.createdAt, stage: "created", events: [],
      reportPath: null, scratchPath: null,
      imageListener: { state: "not-started", port: null },
      nodeFixture: { state: "not-started", executablePath: null, pid: null, pgid: null, identity: null },
      chromium: { state: "not-started", executablePath: null, pid: null, pgid: null, identity: null },
      observedCleanup: null,
    };
  }

  async update(stage, fields = {}) {
    this.record.stage = stage;
    Object.assign(this.record, fields);
    this.record.events.push({ stage, at: new Date().toISOString() });
    if (this.record.events.length > 12) this.record.events.splice(0, this.record.events.length - 12);
    const tempPath = `${this.path}.${++this.sequence}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    try {
      await writeFile(tempPath, `${JSON.stringify(this.record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
