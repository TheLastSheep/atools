import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildBuiltinStateNativeArgs,
  cleanupOwnedBuiltinStateFixtureRoot,
} from "./ztools-builtin-state-native-case.mjs";

const runId = "1234567890ab4cde8fab1234567890ab";
const root = `/private/tmp/atools-renderer-settings-input-${runId}`;

test("seed arguments initialize the existing never-clear fixture without resume authority", () => {
  const args = buildBuiltinStateNativeArgs({
    fixtureRoot: root,
    rendererDist: "/private/tmp/renderer-dist",
    output: "/private/tmp/seed-report.json",
    runId,
    journey: "builtin-state-seed",
  });
  assert.deepEqual(args.slice(-2), ["--journey", "builtin-state-seed"]);
  assert.ok(args.includes("never"));
  assert.equal(args.includes("--resume-seed-pid"), false);
});

test("Main arguments require the actual positive seed PID", () => {
  const args = buildBuiltinStateNativeArgs({
    fixtureRoot: root,
    rendererDist: "/private/tmp/renderer-dist",
    output: "/private/tmp/main-report.json",
    runId,
    journey: "builtin-state",
    resumeSeedPid: 48192,
  });
  assert.deepEqual(args.slice(-4), ["--journey", "builtin-state", "--resume-seed-pid", "48192"]);
  assert.throws(() => buildBuiltinStateNativeArgs({
    fixtureRoot: root,
    rendererDist: "/private/tmp/renderer-dist",
    output: "/private/tmp/main-report.json",
    runId,
    journey: "builtin-state",
  }), /terminal seed PID/);
  assert.throws(() => buildBuiltinStateNativeArgs({
    fixtureRoot: root,
    rendererDist: "/private/tmp/renderer-dist",
    output: "/private/tmp/seed-report.json",
    runId,
    journey: "builtin-state-seed",
    resumeSeedPid: 48192,
  }), /cannot resume/);
});

async function createOwnedRoot(targetRoot, targetRunId, ownerPid) {
  await mkdir(targetRoot, { mode: 0o700 });
  await mkdir(join(targetRoot, "app-data"), { mode: 0o700 });
  await mkdir(join(targetRoot, "webview"), { mode: 0o700 });
  await writeFile(join(targetRoot, ".atools-renderer-smoke-owner.json"), JSON.stringify({
    schemaVersion: 1,
    pid: ownerPid,
    identifier: `dev.atools.renderer-settings-input.${targetRunId}`,
    root: targetRoot,
  }), { flag: "wx", mode: 0o600 });
}

test("cleanup waits for all children and accepts only an owner PID from this terminal pair", {
  skip: process.platform !== "darwin",
}, async () => {
  const targetRunId = randomUUID().replaceAll("-", "");
  const targetRoot = `/private/tmp/atools-renderer-settings-input-${targetRunId}`;
  const seed = { spawned: true, pid: 48001, terminalObserved: true };
  const main = { spawned: true, pid: 48002, terminalObserved: false };
  try {
    assert.equal(await realpath("/private/tmp"), "/private/tmp");
    await createOwnedRoot(targetRoot, targetRunId, seed.pid);
    const held = await cleanupOwnedBuiltinStateFixtureRoot({
      root: targetRoot, runId: targetRunId, processes: [seed, main],
    });
    assert.equal(held.status, "not_attempted");
    assert.equal(held.processTerminal, false);

    main.terminalObserved = true;
    const removed = await cleanupOwnedBuiltinStateFixtureRoot({
      root: targetRoot, runId: targetRunId, processes: [seed, main],
    });
    assert.equal(removed.status, "removed_owned_root");
    assert.equal(removed.rootAbsent, true);

    await createOwnedRoot(targetRoot, targetRunId, 48999);
    const unowned = await cleanupOwnedBuiltinStateFixtureRoot({
      root: targetRoot, runId: targetRunId, processes: [seed, main],
    });
    assert.equal(unowned.status, "preserved");
    assert.equal(unowned.reason, "owner-pid-not-in-case");
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});
