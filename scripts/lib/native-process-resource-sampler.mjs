import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const PS_FIELDS = "pid=,ppid=,pgid=,lstart=,rss=,time=,comm=";
const START = "(\\w{3}\\s+\\w{3}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})";

export function parseCpuTimeSeconds(value) {
  const text = String(value).trim();
  const days = text.match(/^(\d+)-(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (days) {
    const [d, h, m, s] = days.slice(1).map(Number);
    if (h > 23 || m > 59 || s >= 60) throw new Error(`Invalid cumulative process CPU time: ${value}`);
    return d * 86400 + h * 3600 + m * 60 + s;
  }
  const hours = text.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (hours) {
    const [h, m, s] = hours.slice(1).map(Number);
    if (m > 59 || s >= 60) throw new Error(`Invalid cumulative process CPU time: ${value}`);
    return h * 3600 + m * 60 + s;
  }
  const minutes = text.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (minutes) {
    const [m, s] = minutes.slice(1).map(Number);
    if (s >= 60) throw new Error(`Invalid cumulative process CPU time: ${value}`);
    return m * 60 + s;
  }
  throw new Error(`Invalid cumulative process CPU time: ${value}`);
}

export function parseProcessSnapshot(output) {
  const linePattern = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+${START}\\s+(\\d+)\\s+(\\S+)\\s+(.+?)\\s*$`);
  const processes = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(linePattern);
    if (!match) throw new Error(`Unparseable ps process row: ${line.trim().slice(0, 160)}`);
    const [, pid, ppid, pgid, startedAt, rssKiB, cpuTime, command] = match;
    const record = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt,
      rssKiB: Number(rssKiB), cpuSeconds: parseCpuTimeSeconds(cpuTime), command: command.trim() };
    if (![record.pid, record.ppid, record.pgid, record.rssKiB].every(Number.isSafeInteger) || record.rssKiB < 0 || !record.command) {
      throw new Error(`Invalid ps process row for pid ${pid}`);
    }
    if (processes.has(record.pid)) throw new Error(`Duplicate pid in process snapshot: ${pid}`);
    processes.set(record.pid, record);
  }
  return processes;
}

export async function readNativeProcessSnapshot() {
  const { stdout } = await execute("/bin/ps", ["-A", "-ww", "-o", PS_FIELDS], {
    env: { ...process.env, LC_ALL: "C" }, timeout: 2500, maxBuffer: 8 * 1024 * 1024,
  });
  return parseProcessSnapshot(stdout);
}

export function processIdentity(record) {
  if (!record) return null;
  return Object.freeze({ pid: record.pid, pgid: record.pgid, startedAt: record.startedAt, command: record.command });
}

export function sameProcessIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.pgid === b.pgid
    && a.startedAt === b.startedAt && a.command === b.command;
}

export async function captureNativeProcessIdentity(pid, { readSnapshot = readNativeProcessSnapshot, expectedPgid = pid, expectedExecutable } = {}) {
  const snapshot = await readSnapshot();
  const record = snapshot.get(Number(pid));
  if (!record) throw new Error(`Cannot identify launched process ${pid}: absent from ps snapshot`);
  if (record.pgid !== Number(expectedPgid)) throw new Error(`Launched process ${pid} is not in its expected exclusive group`);
  let executableAssertion = "not-checked";
  if (expectedExecutable) {
    if (isAbsolute(record.command)) {
      let actualPath, expectedPath;
      try { actualPath = realpathSync(record.command); expectedPath = realpathSync(expectedExecutable); }
      catch { throw new Error(`Launched process ${pid} executable path could not be canonicalized`); }
      if (actualPath !== expectedPath) throw new Error(`Launched process ${pid} canonical executable path does not match the requested executable`);
      executableAssertion = "canonical-path";
    } else {
      if (basename(record.command) !== basename(expectedExecutable)) {
        throw new Error(`Launched process ${pid} executable basename does not match the requested executable`);
      }
      executableAssertion = "basename-only";
    }
  }
  return Object.freeze({ ...processIdentity(record), executableAssertion });
}

function isWebKitCandidate(command) {
  const name = basename(command).toLowerCase();
  return name.includes("webkit") || name.includes("com.apple.webcontent");
}

function identityKey(record) {
  return `${record.pid}\u0000${record.pgid}\u0000${record.startedAt}\u0000${record.command}`;
}

function ownedRecords(snapshot, rootIdentity, pinnedIdentities, confirmedGroupMembers, groupClosed) {
  const root = snapshot.get(rootIdentity.pid);
  const rootLive = sameProcessIdentity(processIdentity(root), rootIdentity);
  const exclusiveGroup = rootIdentity.pgid === rootIdentity.pid;
  const owned = new Map();
  if (rootLive) owned.set(root.pid, root);
  if (rootLive && exclusiveGroup) {
    for (const record of snapshot.values()) if (record.pgid === rootIdentity.pgid) {
      owned.set(record.pid, record);
      confirmedGroupMembers.set(record.pid, identityKey(record));
    }
  } else if (exclusiveGroup && !groupClosed) {
    for (const [pid, key] of confirmedGroupMembers) {
      const record = snapshot.get(pid);
      if (record && identityKey(record) === key && record.pgid === rootIdentity.pgid) owned.set(pid, record);
    }
  }
  // Cross-group helpers are admitted only by an explicitly captured live identity.
  for (const identity of pinnedIdentities) {
    const record = snapshot.get(identity.pid);
    if (sameProcessIdentity(processIdentity(record), identity)) owned.set(record.pid, record);
  }
  const groupHasMembers = [...owned.values()].some(record => record.pgid === rootIdentity.pgid);
  return { owned, rootLive, exclusiveGroup, groupClosed: groupClosed || (!rootLive && !groupHasMembers) };
}

/** Samples only a launched root, members of its exclusive process group, and explicitly pinned identities. */
export function createNativeProcessResourceSampler({ rootIdentity, readSnapshot = readNativeProcessSnapshot,
  now = () => performance.now(), pinnedIdentities = [], maxSamples = 1200 } = {}) {
  if (!rootIdentity || !Number.isSafeInteger(rootIdentity.pid)) throw new Error("A captured root process identity is required");
  if (!Number.isInteger(maxSamples) || maxSamples < 1) throw new Error("maxSamples must be positive");
  const samples = [], previousCpu = new Map(), confirmedGroupMembers = new Map();
  let previousAt = null, pending, groupClosed = false;

  async function sample() {
    if (pending) return pending;
    pending = (async () => {
      if (samples.length >= maxSamples) return null;
      const [snapshot, sampledAt] = await Promise.all([readSnapshot(), Promise.resolve(now())]);
      const { owned, rootLive, exclusiveGroup, groupClosed: nextGroupClosed } =
        ownedRecords(snapshot, rootIdentity, pinnedIdentities, confirmedGroupMembers, groupClosed);
      groupClosed = nextGroupClosed;
      const nextCpu = new Map();
      for (const [pid, record] of owned) nextCpu.set(pid, { key: identityKey(record), seconds: record.cpuSeconds });
      const elapsedMs = previousAt === null ? null : sampledAt - previousAt;
      let cpuSecondsDelta = null;
      if (elapsedMs !== null && elapsedMs > 0) {
        cpuSecondsDelta = 0;
        for (const [pid, current] of nextCpu) {
          const previous = previousCpu.get(pid);
          if (previous?.key === current.key) cpuSecondsDelta += Math.max(0, current.seconds - previous.seconds);
        }
      }
      const processes = [...owned.values()].sort((a, b) => a.pid - b.pid).map(record => ({
        pid: record.pid, ppid: record.ppid, pgid: record.pgid, rssBytes: record.rssKiB * 1024,
      }));
      const sample = {
        sampledAtMs: sampledAt, rootLive, exclusiveGroup, processGroupClosed: groupClosed, processCount: processes.length,
        rssBytes: processes.reduce((total, record) => total + record.rssBytes, 0), processes,
        elapsedMs, cpuSecondsDelta,
        cpuPercentOneCore: cpuSecondsDelta === null ? null : elapsedMs > 0 ? cpuSecondsDelta / (elapsedMs / 1000) * 100 : null,
        unattributedWebKitCandidates: [...snapshot.values()].filter(record => !owned.has(record.pid) && isWebKitCandidate(record.command)).map(record => ({
          pid: record.pid, rssBytes: record.rssKiB * 1024,
        })),
      };
      previousAt = sampledAt;
      previousCpu.clear();
      for (const [pid, state] of nextCpu) previousCpu.set(pid, state);
      samples.push(sample);
      return sample;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  function report() {
    const last = samples.at(-1) ?? null;
    const live = samples.filter(item => item.rootLive);
    const cpuPeaks = samples.map(item => item.cpuPercentOneCore).filter(Number.isFinite);
    return {
      scope: "exact launched process identity + its exclusive process group + explicitly pinned identities",
      rssMetric: "Per-process RSS KiB from ps multiplied by 1024 and summed; shared pages may be counted more than once, so this is not physical footprint or full application memory",
      cpuMetric: "cumulative ps CPU-time delta for process identities present and unchanged at both adjacent snapshot endpoints / monotonic elapsed; 100% equals one fully busy core",
      cpuCoverage: "New or exited-between-snapshot processes are omitted from that interval, so short bursts and peaks may understate whole-group CPU; the monotonic sample timestamp is taken as the ps snapshot command starts, so snapshot latency adds interval uncertainty",
      identityPrecision: "Spawn PID + PGID + command + ps lstart token (one-second resolution on macOS); reused identities are excluded when any token differs",
      launchIdentity: summarizeProcessIdentity(rootIdentity),
      coverage: {
        exclusiveGroupProven: rootIdentity.pgid === rootIdentity.pid,
        launchedExecutableAssertion: rootIdentity.executableAssertion ?? "not-checked",
        rootObservedSamples: live.length,
        sampleCount: samples.length,
        lastSampleRootLive: last?.rootLive ?? false,
        omitted: ["WKWebContent and other launchd/reparented XPC processes unless an exact identity is explicitly pinned",
          "processes that escaped the exclusive process group and were never explicitly pinned", "system-wide memory and CPU"],
      },
      samples: [...samples],
      peakRssBytes: live.length ? Math.max(...live.map(item => item.rssBytes)) : null,
      peakCpuPercentOneCore: cpuPeaks.length ? Math.max(...cpuPeaks) : null,
    };
  }

  return { sample, report };
}

export function summarizeProcessIdentity(identity) {
  return identity ? { pid: identity.pid, pgid: identity.pgid, startedAt: identity.startedAt,
    executableName: basename(identity.command) } : null;
}
