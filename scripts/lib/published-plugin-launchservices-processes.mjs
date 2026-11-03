import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseCpuTimeSeconds, processIdentity } from "./native-process-resource-sampler.mjs";

const execute = promisify(execFile);

export function parseLaunchServicesProcessSnapshot(output) {
  const processes = new Map();
  const rowPattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
  for (const [index, line] of String(output).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = line.match(rowPattern);
    if (!match) throw new Error(`Unparseable LaunchServices ps row index=${index + 1} bytes=${Buffer.byteLength(line)} sha256=${createHash("sha256").update(line).digest("hex")}`);
    const [, pidText, ppidText, pgidText, startText, rssText, cpuTime, command] = match;
    const record = { pid: Number(pidText), ppid: Number(ppidText), pgid: Number(pgidText),
      startedAt: startText.split(/\s+/).join(" "), rssKiB: Number(rssText), cpuSeconds: parseCpuTimeSeconds(cpuTime), command: command.trim() };
    if (![record.pid, record.ppid, record.pgid, record.rssKiB].every(Number.isSafeInteger)
      || record.rssKiB < 0 || !record.command || processes.has(record.pid)) {
      throw new Error(`Invalid or duplicate LaunchServices ps identity for pid ${pidText}`);
    }
    processes.set(record.pid, record);
  }
  return processes;
}

export function countTaggedLaunchServicesProcesses(snapshot, tag) {
  if (!(snapshot instanceof Map) || typeof tag !== "string" || !tag || /\s/.test(tag)) {
    throw new Error("A valid process snapshot and exact run tag are required");
  }
  let count = 0;
  for (const record of snapshot.values()) {
    const tokens = record.command.split(/\s+/);
    if (record.command === tag || tokens.includes(tag) || tokens.includes(`--title=${tag}`)) count += 1;
  }
  return count;
}

export async function readLaunchServicesProcessSnapshot() {
  const { stdout } = await execute("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,rss=,time=,args="], {
    env: { ...process.env, LC_ALL: "C" }, timeout: 2500, maxBuffer: 8 * 1024 * 1024,
  });
  return parseLaunchServicesProcessSnapshot(stdout);
}

export async function trackLaunchServicesChildren(rootPid, executable, tag, {
  readSnapshot = readLaunchServicesProcessSnapshot, signalProcess = process.kill,
} = {}) {
  const owned = new Map();
  const seenOwnedIdentities = new Map();
  const unresolved = new Map();
  const closedByReuse = new Map();
  const closedByAbsence = new Map();
  let rootIdentity = null;
  const snapshotNow = async () => readSnapshot();
  const tagMatches = record => {
    const tokens = record.command.split(/\s+/);
    return tokens.includes(tag) || tokens.includes(`--title=${tag}`);
  };
  const rememberOwned = identity => {
    const key = `${identity.pid}\0${identity.startedAt}`;
    if (!seenOwnedIdentities.has(key)) seenOwnedIdentities.set(key, identity);
    owned.set(identity.pid, identity);
  };
  const identitySummary = identity => ({ pid: identity.pid, pgid: identity.pgid, startedAt: identity.startedAt,
    commandSha256: createHash("sha256").update(identity.command).digest("hex"),
    executableName: identity.command.split(/[\\/]/).at(-1) });
  const observeIdentity = (pid, record) => {
    const old = owned.get(pid);
    if (!old) return;
    if (!record) {
      closedByAbsence.set(pid, identitySummary(old));
      owned.delete(pid);
      return;
    }
    if (record.startedAt !== old.startedAt) {
      closedByReuse.set(pid, { old: identitySummary(old), observedReplacement: identitySummary(processIdentity(record)) });
      owned.delete(pid);
      unresolved.delete(pid);
      return;
    }
    if (!sameRecord(record, old)) {
      unresolved.set(pid, { identity: identitySummary(old), observed: identitySummary(processIdentity(record)),
        reason: "same-start-token-command-or-process-group-changed" });
      owned.delete(pid);
    }
  };
  const discover = snapshot => {
    const root = snapshot.get(rootPid);
    if (root) {
      if (!rootIdentity) {
        const expected = resolve(executable);
        if (root.command !== expected && !root.command.startsWith(expected + " ")) throw new Error("target PID executable changed before tree capture");
        rootIdentity = processIdentity(root);
        rememberOwned(rootIdentity);
      } else if (!sameRecord(root, rootIdentity)) {
        if (root.startedAt !== rootIdentity.startedAt) {
          closedByReuse.set(rootPid, { old: identitySummary(rootIdentity), observedReplacement: identitySummary(processIdentity(root)) });
        } else unresolved.set(rootPid, { identity: identitySummary(rootIdentity), observed: identitySummary(processIdentity(root)),
          reason: "target-same-start-token-command-or-process-group-changed" });
        throw new Error("target PID identity changed while tracking children");
      }
    }
    for (const [pid, identity] of owned) observeIdentity(pid, snapshot.get(pid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid] of owned) if (!snapshot.has(pid)) observeIdentity(pid, null);
      for (const record of snapshot.values()) {
        const parent = snapshot.get(record.ppid);
        const parentOwned = owned.get(record.ppid);
        if ((tagMatches(record) || parentOwned && parent && sameRecord(parent, parentOwned))
          && !unresolved.has(record.pid) && !closedByReuse.has(record.pid)) {
          const identity = processIdentity(record);
          const previous = owned.get(record.pid);
          if (!previous) { rememberOwned(identity); changed = true; }
          else observeIdentity(record.pid, record);
        }
      }
    }
  };
  const sameRecord = (record, identity) => record.pid === identity.pid && record.pgid === identity.pgid
    && record.startedAt === identity.startedAt && record.command === identity.command;
  const scan = async () => { const snapshot = await snapshotNow(); discover(snapshot); return snapshot; };
  const signalOwned = async signal => {
    const snapshot = await scan();
    const live = [...owned.entries()].filter(([pid, identity]) => {
      const record = snapshot.get(pid); return record && sameRecord(record, identity) && pid !== rootPid;
    }).map(([pid]) => pid);
    const signaled = [];
    for (const pid of live.reverse()) {
      const verification = await snapshotNow();
      const identity = owned.get(pid), current = verification.get(pid);
      if (!identity || !current || !sameRecord(current, identity)) continue;
      try { signalProcess(pid, signal); signaled.push(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    return signaled;
  };
  await scan();
  return {
    rootIdentity,
    async cleanup() {
      const termPids = await signalOwned("SIGTERM");
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline) {
        const snapshot = await scan();
        if (![...owned.keys()].some(pid => pid !== rootPid && snapshot.has(pid))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const killPids = await signalOwned("SIGKILL");
      const final = await scan();
      const survivors = [...owned.entries()].filter(([pid, identity]) => pid !== rootPid
        && final.has(pid) && sameRecord(final.get(pid), identity)).map(([pid]) => pid);
      const identities = [...seenOwnedIdentities.values()].map(identity => ({ pid: identity.pid, pgid: identity.pgid,
        startedAt: identity.startedAt, commandSha256: createHash("sha256").update(identity.command).digest("hex"),
        executableName: identity.command.split(/[\\/]/).at(-1) })).sort((a, b) => a.pid - b.pid);
      return { attempted: true, termPids, killPids, survivors, ownedObservedCount: seenOwnedIdentities.size,
        currentOwnedCount: owned.size, identities,
        unresolved: [...unresolved.values()], closedByReuse: [...closedByReuse.values()], closedByAbsence: [...closedByAbsence.values()],
        unresolvedCount: unresolved.size, coverage: "unknown-unobserved-detached-descendants" };
    },
    async snapshot() { return scan(); },
  };
}

function sameRecord(record, identity) {
  return !!record && !!identity && record.pid === identity.pid && record.pgid === identity.pgid
    && record.startedAt === identity.startedAt && record.command === identity.command;
}
