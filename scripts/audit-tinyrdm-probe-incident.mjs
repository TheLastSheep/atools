#!/usr/bin/env node
// Reads only these known incident paths; never reads user configuration contents.
import { createHash } from "node:crypto";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, "output/legacy-node-2026-10-15/tinyrdm-probe-incident.json");
const pluginRoot = join(root, "ZTools-plugins/plugins/tiny-rdm");
const configRoot = "/Users/harris/Library/Preferences/TinyRDM";
async function metadata(file) {
  try {
    const value = await stat(file);
    return { path: file, exists: true, type: value.isDirectory() ? "directory" : "file", bytes: value.size,
      mode: (value.mode & 0o777).toString(8), birthAt: value.birthtime.toISOString(), modifiedAt: value.mtime.toISOString(),
      metadataChangedAt: value.ctime.toISOString() };
  } catch (error) { return { path: file, exists: error.code === "ENOENT" ? false : null, error: error.code }; }
}
async function fileEvidence(file) {
  return { ...await metadata(file), sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
}
async function portStatus(host) {
  return new Promise(resolve => {
    const socket = connect({ host, port: 8088 });
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); resolve({ host, port: 8088, status: "accepting" }); });
    socket.once("error", error => resolve({ host, port: 8088, status: error.code === "ECONNREFUSED" ? "refused" : "inconclusive", code: error.code }));
    socket.once("timeout", () => { socket.destroy(); resolve({ host, port: 8088, status: "inconclusive", code: "TIMEOUT" }); });
  });
}
let processCheck;
try { processCheck = { command: "ps -p 69361 -o pid=,ppid=,lstart=,command=", output: (await run("/bin/ps", ["-p", "69361", "-o", "pid=,ppid=,lstart=,command="])).stdout.trim() }; }
catch (error) { processCheck = { knownPid: 69361, notPresent: error.code === 1 && !error.stdout?.trim(), code: error.code }; }
const binary = join(pluginRoot, "lib/tinyrdm");
let binaryExtendedAttributeNames;
try { binaryExtendedAttributeNames = (await run("/usr/bin/xattr", [binary])).stdout.trim().split("\n").filter(Boolean); }
catch (error) { binaryExtendedAttributeNames = { error: error.code }; }
const report = {
  schema_version: 1, observedAt: new Date().toISOString(),
  incident: "Original TinyRDM DOMContentLoaded hook spawned its bundled detached native service during a diagnostic discovery load.",
  scope: { noConfigurationContentsRead: true, onlyKnownIncidentPathsInspected: true, noUserFilesRemovedMovedOrRestored: true,
    sourceHashMeaning: "Hashes establish observed code bytes only. They do not establish unchanged permission, xattr, filesystem or connection state.",
    earlierCleanupMeaning: "Earlier matrix listenerClosed/nodeProcessStopped cover the temporary transport and Node parent only; a detached TinyRDM child outlived that cleanup.",
    environmentIsolation: "The affected diagnostic inherited the real HOME. New fixtures isolate HOME/XDG/APPDATA/TMP and exclude ambient environment; this is not an OS sandbox." },
  timing: { preciseNativeStartAt: null, preciseNativeStopAt: null,
    missingEvidence: "No per-plugin wall-clock event or process lstart was captured before termination. File birth/ctime and report boundaries are retained as observations, not substituted for exact process timestamps.",
    discoveryRuns: [
      { report: "original-plugin-expanded-discovery.json", beganAt: "2026-10-15T14:31:00.810Z", reportModifiedAt: "2026-10-15T14:46:25.893Z", tinyRdmIndexZeroBased: 43 },
      { report: "original-remaining-host-discovery.json", beganAt: "2026-10-15T14:45:02.509Z", reportModifiedAt: "2026-10-15T14:47:02.444Z", tinyRdmIndexZeroBased: 27 },
    ], priorTermination: { verifiedExecutable: binary, pid: 69361, observedParentPid: 1, observedProcessGroup: 69361,
      action: "SIGKILL sent only after matching the recorded executable; subsequent known-PID and port checks found it stopped", exactAt: null } },
  originalLaunchContract: { source: "preload/services.js", hook: "DOMContentLoaded -> isServerRunning -> spawnServer",
    healthProbe: "http://localhost:8088/api/auth/status", pollMilliseconds: 1000,
    executable: binary, arguments: [], cwd: dirname(binary), stdio: "ignore", detached: true, unref: true,
    nativeMetadataOperations: ["chmodSync(executable, 0755)", "execFileSync('xattr', ['-cr', executable]) on darwin"],
    exitHook: "onPluginOut(isKill) stops the service only when isKill is truthy; the diagnostic had invoked the hook without this argument" },
  staticNativeAnalysis: { method: "Read-only Go build metadata, Mach-O __gopclntab function mapping and targeted arm64 disassembly; the binary was not restarted for this audit.",
    build: { go: "go1.25.5", module: "tinyrdm", version: "v1.2.6+dirty", os: "darwin", architecture: "arm64", cgo: false, tags: "web" },
    bind: { function: "main.main", address: "0x100549750", portEnvironment: "PORT", defaultPort: "8088", addressFormat: "0.0.0.0:%s", inference: "Default listener is all IPv4 interfaces, not loopback-only." },
    authentication: { function: "tinyrdm/backend/api.InitAuth", address: "0x10053bff0", environmentKeys: ["ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_TTL"],
      inference: "Auth is enabled only when both ADMIN_USERNAME and ADMIN_PASSWORD are nonempty. The affected Node environment whitelist excluded those keys; no credential values were read." },
    configuration: { functions: ["NewLocalStore at 0x1004d2520", "userdir.GetConfigHome at 0x1003cf320", "NewPreferences at 0x1004d2710"],
      derivation: "GetConfigHome reads HOME and joins Library/Preferences; NewLocalStore joins TinyRDM; NewPreferences selects preferences.yaml.", exactRoot: configRoot },
    logging: { originalStdio: "Native stdout/stderr were ignored by the original spawn options.", independentLogFile: "Not confirmed; no broad user-directory search or configuration content read was performed." } },
  currentCode: { preload: await fileEvidence(join(pluginRoot, "preload/services.js")), binary: await fileEvidence(binary), binaryExtendedAttributeNames },
  knownUserPathMetadata: await Promise.all([configRoot, join(configRoot, "preferences.yaml"), join(configRoot, "device.txt"), join(configRoot, "decoder")].map(metadata)),
  baseline: { userTinyRdmDirectoryBeforeTest: "absent evidence", binaryModeBeforeTest: "absent evidence", binaryXattrsBeforeTest: "absent evidence",
    conclusion: "The observed directory birth times overlap the diagnostic window, but no pre-test baseline establishes prior user state or permits guessing a restoration. No path has been deleted, moved or overwritten by this audit." },
  currentState: { checkedAt: new Date().toISOString(), processCheck, tcp: await Promise.all([portStatus("127.0.0.1"), portStatus("::1")]) },
  unresolved: ["Exact native start/stop times", "Historical external connections while the all-interface listener was active", "Whether any existing user connections/configuration were accessed", "Pre-test permission/xattr and preference-directory baseline", "Any independent native log file path"],
  nextExecutionPolicy: "TinyRDM and other unconstrained auto-spawning, all-interface-listening or real-path-writing entries remain not_exercised. Only explicitly reviewed scratch/crypto/in-memory/loopback probes may resume.",
};
await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, observedAt: report.observedAt, processCheck, tcp: report.currentState.tcp, configurationContentsRead: false }, null, 2));
