import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

type OfficeCliPageControls = { wait: (expression: string, label: string, timeoutMs?: number) => Promise<unknown>;
  evaluate: (expression: string) => Promise<any> };

export const OFFICECLI_SOURCE = "/Users/harris/.local/bin/officecli";
export const OFFICECLI_SHA256 = "67cf08d95fab556cad9d1e9d0d3b76a7962b5658c716aeaef2e83cbc19af7ff7";
export const OFFICECLI_BYTES = 33_896_240;

export type PinnedOfficeCli = {
  binaryPath: string;
  binaryDirectory: string;
  bytes: number;
  sha256: string;
  fixtureEnv: Record<string, string>;
};

/** Copy the already-installed helper into the private scratch root without running it. */
export async function copyPinnedOfficeCli(scratchRoot: string, fixtureEnv: Record<string, string>): Promise<PinnedOfficeCli> {
  const bytes = await readFile(OFFICECLI_SOURCE);
  const sha256 = hash(bytes);
  assert.equal(bytes.length, OFFICECLI_BYTES, "Installed OfficeCLI byte size changed from the frozen pin");
  assert.equal(sha256, OFFICECLI_SHA256, "Installed OfficeCLI bytes do not match the frozen SHA-256 pin");

  const binaryDirectory = resolve(scratchRoot, ".local", "bin");
  const binaryPath = join(binaryDirectory, "officecli");
  await mkdir(binaryDirectory, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(binaryDirectory), binaryDirectory,
    "Private OfficeCLI directory must be canonical and must not traverse a symlink");
  await writeFile(binaryPath, bytes, { flag: "wx", mode: 0o700 });
  await chmod(binaryPath, 0o700);
  const [ownedStat, ownedPath, copiedBytes] = await Promise.all([
    lstat(binaryPath), realpath(binaryPath), readFile(binaryPath),
  ]);
  assert.ok(ownedStat.isFile() && !ownedStat.isSymbolicLink(), "Private OfficeCLI copy must be a regular non-symlink file");
  assert.equal(ownedPath, binaryPath, "Private OfficeCLI copy must not resolve through a symlink");
  assert.equal(hash(copiedBytes), OFFICECLI_SHA256, "Private OfficeCLI copy hash changed");

  return {
    binaryPath, binaryDirectory, bytes: copiedBytes.length, sha256,
    fixtureEnv: { ...fixtureEnv, PATH: `${binaryDirectory}${delimiter}${fixtureEnv.PATH}` },
  };
}

/** Independently serialize the fixed worksheet matrix to the expected RFC 4180-compatible CSV. */
export function expectedCsvFromMatrix(matrix: readonly (readonly string[])[]) {
  return matrix.map(row => row.map(value => {
    const cell = String(value);
    return /[",\r\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell;
  }).join(",")).join("\n");
}

export async function readOfficeCliRuntimeUi(controls: OfficeCliPageControls) {
  const expression = `(()=>{const pill=Array.from(document.querySelectorAll('.runtime-pill')).find(e=>e.querySelector('strong')?.innerText.trim()==='OfficeCLI');` +
    `if(!pill)return false;const small=pill.querySelector('small');return pill.classList.contains('ready')&&!!small?.innerText.trim()})()`;
  await controls.wait(expression, "original UI to show the real OfficeCLI version as ready", 30_000);
  const result = await controls.evaluate(`(()=>{const pill=Array.from(document.querySelectorAll('.runtime-pill')).find(e=>e.querySelector('strong')?.innerText.trim()==='OfficeCLI');` +
    `const small=pill?.querySelector('small');if(!pill||!small)return null;pill.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});` +
    `const r=pill.getBoundingClientRect(),s=getComputedStyle(pill);return {label:pill.querySelector('strong')?.innerText.trim(),` +
    `className:pill.className,version:small.innerText.trim(),installButton:!!pill.querySelector('button'),display:s.display,visibility:s.visibility,` +
    `left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`);
  assert.ok(result, "Original Format Converter OfficeCLI runtime pill must be visible in the DOM");
  assert.equal(result.label, "OfficeCLI");
  assert.ok(result.className.split(/\s+/u).includes("ready"), "Original UI must mark the pinned OfficeCLI as ready");
  assert.ok(result.version && result.version !== "可用", "Original UI must display the actual OfficeCLI version string");
  assert.equal(result.installButton, false, "Ready OfficeCLI must not offer an installation action");
  assert.notEqual(result.display, "none");
  assert.notEqual(result.visibility, "hidden");
  assert.ok(result.width > 0 && result.height > 0 && result.right > 0 && result.left < result.viewportWidth
    && result.bottom > 0 && result.top < result.viewportHeight, "OfficeCLI status must intersect the current viewport");
  return result;
}

export function assertOfficeCliCalls(snapshot: Record<string, any>, pinned: PinnedOfficeCli, expectedViewCalls: number) {
  const helper = snapshot.helperProcesses;
  assert.ok(helper && helper.enabled === true, "Node session must expose the configured OfficeCLI process telemetry");
  assert.equal(helper.binaryPath, pinned.binaryPath);
  assert.equal(helper.sha256, OFFICECLI_SHA256);
  assert.deepEqual(helper.environmentPolicy, { privateFixtureEnv: true, noAutoResident: true, skipUpdate: true,
    workingDirectoryPolicy: "scratchRoot" });
  assert.equal(helper.childLifecycleScope, "direct-child-only",
    "OfficeCLI telemetry confirms only its direct child; detached descendants are outside this fixture's proof");
  assert.equal(helper.attempts, expectedViewCalls + 1);
  assert.equal(helper.versionCalls, 1, "Original preload should probe the real pinned OfficeCLI version once");
  assert.equal(helper.viewCalls, expectedViewCalls, "Only the expected fixed-input OfficeCLI text views may run");
  assert.equal(helper.errors, 0, "Pinned OfficeCLI subprocesses must not have spawn errors");
  assert.ok(Number.isSafeInteger(helper.denials) && helper.denials >= 0, "Helper policy denials must be counted");
  assert.equal(helper.killRequests, 0, "Pinned OfficeCLI processes must exit without timeout or forced termination");
  assert.equal(helper.killed, 0);
  assert.equal(helper.deadlines, 0);
  assert.equal(helper.cleanupFailures, 0);
  assert.equal(helper.nonzeroExits, 1, "Only the malformed DOCX text parse should exit unsuccessfully");
  assert.equal(helper.active, 0);
  assert.equal(helper.started, expectedViewCalls + 1);
  assert.equal(helper.exited, helper.started);
  assert.equal(helper.closed, helper.started);
  assert.equal(helper.closeConfirmed, true);

  assert.ok(Array.isArray(helper.events));
  const denied = helper.events.filter((event: Record<string, unknown>) => event.event === "denied");
  assert.ok(denied.length <= helper.denials, "Bounded events may omit older denials; their counter remains preserved");
  assert.ok(denied.every((event: Record<string, unknown>) => event.operation === "other"),
    "Non-OfficeCLI process probes must be rejected and reported as unrelated operations");
  const allowedEvents = helper.events.filter((event: Record<string, unknown>) => event.event !== "denied");
  assert.ok(allowedEvents.every((event: Record<string, unknown>) => ["attempt", "spawn", "exit", "close"].includes(String(event.event))
    && ["version", "view"].includes(String(event.operation))), "Only version/view may reach OfficeCLI process lifecycle events");
  const attempts = helper.events.filter((event: Record<string, unknown>) => event.event === "attempt");
  assert.deepEqual(attempts.map((event: Record<string, unknown>) => event.operation),
    ["version", ...Array.from({ length: expectedViewCalls }, () => "view")]);
  const exits = helper.events.filter((event: Record<string, unknown>) => event.event === "exit");
  const versionExit = exits.filter((event: Record<string, unknown>) => event.operation === "version");
  const viewExits = exits.filter((event: Record<string, unknown>) => event.operation === "view");
  assert.equal(versionExit.length, 1);
  assert.equal(versionExit[0].code, 0);
  assert.equal(viewExits.length, expectedViewCalls);
  assert.equal(viewExits.filter((event: Record<string, unknown>) => event.code === 0).length, expectedViewCalls - 1);
  assert.equal(viewExits.filter((event: Record<string, unknown>) => typeof event.code === "number" && event.code !== 0).length, 1);
  return helper;
}

export function assertOfficeCliClosed(snapshot: Record<string, any>) {
  const helper = snapshot.helperProcesses;
  assert.ok(helper && helper.enabled === true, "Stopped Node snapshot must retain OfficeCLI process telemetry");
  assert.equal(helper.active, 0);
  assert.equal(helper.attempts, helper.closed);
  assert.equal(helper.started, helper.exited);
  assert.equal(helper.cleanupFailures, 0);
  assert.equal(helper.closeConfirmed, true);
  assert.equal(helper.childLifecycleScope, "direct-child-only");
  return helper;
}

function hash(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
