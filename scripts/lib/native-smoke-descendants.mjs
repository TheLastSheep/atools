import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processSnapshot(tag) {
  const label=process.platform==="darwin"?"comm":"args";
  const { stdout } = await execute("/bin/ps", ["-A", "-o", `pid=,ppid=,pgid=,lstart=,${label}=`], {
    env: { ...process.env, LC_ALL: "C" }, timeout: 2000, maxBuffer: 8 * 1024 * 1024,
  });
  return new Map(stdout.trim().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/);
    return match ? [[Number(match[1]), {
      parent: Number(match[2]), group: Number(match[3]), identity: `${match[3]}:${match[4]}`,
      tagged: match[5] === tag,
    }]] : [];
  }));
}

/**
 * Caller must spawn a new exclusive POSIX group (PGID === child.pid).
 * A live group reserves its ID after its leader exits. Admit individual members
 * while that group exists, then recheck their creation identities before signals.
 * Once the group is observed empty/reused, never admit a later group with that ID.
 * Tags cover cooperative sidecars which deliberately start separate sessions.
 * This is test cleanup, not a sandbox for arbitrary reparenting/title changes.
 */
export function trackNativeDescendants(child,tag) {
  const owned = new Map();
  let pending,rootIdentity,groupSeen=false,groupClosed=false;
  const discover = (snapshot) => {
    const root=snapshot.get(child.pid);
    if (!rootIdentity && child.exitCode===null && child.signalCode===null && root?.group===child.pid) rootIdentity=root.identity;
    if (rootIdentity && root && root.identity!==rootIdentity) groupClosed=true;
    const hasGroup=[...snapshot.values()].some(record=>record.group===child.pid);
    if(hasGroup)groupSeen=true;
    else if(groupSeen || child.exitCode!==null || child.signalCode!==null)groupClosed=true;
    const parents = new Set(rootIdentity && root?.identity===rootIdentity ? [child.pid] : []);
    for (const [pid,record] of snapshot) {
      if (record.tagged || (!groupClosed && record.group===child.pid)) {
        owned.set(pid,record.identity);parents.add(pid);
      }
    }
    for (const [pid, identity] of owned) {
      if (snapshot.get(pid)?.identity === identity) parents.add(pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, record] of snapshot) {
        if (!parents.has(pid) && parents.has(record.parent)) {
          parents.add(pid); owned.set(pid, record.identity); changed = true;
        }
      }
    }
  };
  const capture = () => {
    if (pending) return pending;
    pending = (async () => {
      const snapshot = await processSnapshot(tag);
      discover(snapshot);
    })().catch(() => {}).finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(capture, 250);
  void capture();
  return async () => {
    clearInterval(timer);
    await capture();
    const signalOwned = async (signal) => {
      const snapshot = await processSnapshot(tag);
      // A cooperative TERM handler may spawn another child. Reuse the complete
      // discovery pass before KILL, not just the title lookup.
      discover(snapshot);
      const depth = (pid) => {
        const visited=new Set();
        while (!visited.has(pid) && visited.size<128) {
          visited.add(pid);
          const parent=snapshot.get(pid)?.parent, record=snapshot.get(parent);
          if (!record || owned.get(parent)!==record.identity) break;
          pid=parent;
        }
        return visited.size;
      };
      const live=[...owned].filter(([pid,identity])=>snapshot.get(pid)?.identity===identity);
      const levels=new Map(live.map(([pid])=>[pid,depth(pid)]));
      live.sort(([a],[b])=>levels.get(b)-levels.get(a));
      for (const [pid] of live) {
        try { process.kill(pid, signal); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    };
    // Re-check PID creation identity before each signal; never target a reused PID.
    await signalOwned("SIGTERM");
    await pause(200);
    await signalOwned("SIGKILL");
  };
}
