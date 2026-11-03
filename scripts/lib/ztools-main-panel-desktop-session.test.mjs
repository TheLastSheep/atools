import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";
import {
  assertInteractiveDesktopSession,
  readDesktopSession,
} from "./ztools-main-panel-desktop-session.mjs";

const unlockedSession = Object.freeze({
  sessionAvailable: true,
  onConsole: true,
  loginDone: true,
  screenLocked: false,
});

function executorReturning(output, options = {}) {
  let cachePath;
  return {
    get cachePath() { return cachePath; },
    run: async (executable, args, execOptions) => {
      assert.equal(executable, "/usr/bin/swift");
      assert.deepEqual(args.slice(0, 1), ["-module-cache-path"]);
      assert.equal(execOptions.timeout, 30_000);
      assert.equal(execOptions.maxBuffer, 4_096);
      cachePath = args[1];
      assert.match(cachePath, /^\/private\/tmp\/atools-desktop-session-/);
      assert.equal(args[2], "-e");
      assert.match(args[3], /CGSessionCopyCurrentDictionary/);
      assert.match(args[3], /kCGSSessionOnConsoleKey/);
      assert.match(args[3], /kCGSessionLoginDoneKey/);
      assert.match(args[3], /CGSSessionScreenIsLocked/);
      assert.doesNotMatch(args[3], /UserName|userName|username/);
      if (options.error) throw options.error;
      return { stdout: output, stderr: "" };
    },
  };
}

async function assertOwnCacheRemoved(executor) {
  assert.ok(executor.cachePath);
  await assert.rejects(lstat(executor.cachePath), { code: "ENOENT" });
}

function rawJson(overrides = {}) {
  return JSON.stringify({ ...unlockedSession, ...overrides });
}

test("reads only the four fixed session booleans and removes its private Swift cache", async () => {
  const executor = executorReturning(rawJson());
  const observation = await readDesktopSession({ execFileImpl: executor.run });

  assert.deepEqual(Object.keys(observation).sort(), [
    "loginDone",
    "observedAt",
    "onConsole",
    "screenLocked",
    "sessionAvailable",
  ]);
  assert.equal(observation.sessionAvailable, true);
  assert.equal(observation.onConsole, true);
  assert.equal(observation.loginDone, true);
  assert.equal(observation.screenLocked, false);
  assert.equal(Number.isNaN(Date.parse(observation.observedAt)), false);
  assert.strictEqual(assertInteractiveDesktopSession(observation), observation);
  await assertOwnCacheRemoved(executor);
});

test("fails closed for locked, unavailable, non-console, incomplete, and unknown sessions", async (t) => {
  const cases = [
    ["locked", { screenLocked: true }, "desktop-session-locked"],
    ["lock state unknown", { screenLocked: null }, "desktop-session-lock-state-unknown"],
    ["session missing", { sessionAvailable: false }, "desktop-session-unavailable"],
    ["session availability unknown", { sessionAvailable: null }, "desktop-session-availability-unknown"],
    ["not on console", { onConsole: false }, "desktop-session-not-on-console"],
    ["console state unknown", { onConsole: null }, "desktop-session-console-state-unknown"],
    ["login incomplete", { loginDone: false }, "desktop-session-login-incomplete"],
    ["login state unknown", { loginDone: null }, "desktop-session-login-state-unknown"],
  ];

  for (const [name, override, expectedCode] of cases) {
    await t.test(name, () => {
      const observation = {
        ...unlockedSession,
        ...override,
        observedAt: "2026-10-29T12:00:00.000Z",
      };
      assert.throws(() => assertInteractiveDesktopSession(observation), { code: expectedCode });
    });
  }
});

test("preserves unknown source fields as null instead of converting them to false", async () => {
  const executor = executorReturning(rawJson({ onConsole: null, screenLocked: null }));
  const observation = await readDesktopSession({ execFileImpl: executor.run });
  assert.equal(observation.onConsole, null);
  assert.equal(observation.screenLocked, null);
  assert.throws(() => assertInteractiveDesktopSession(observation), {
    code: "desktop-session-console-state-unknown",
  });
  await assertOwnCacheRemoved(executor);
});

test("parses an absent session as unavailable with unknown session details", async () => {
  const executor = executorReturning(JSON.stringify({
    sessionAvailable: false,
    onConsole: null,
    loginDone: null,
    screenLocked: null,
  }));
  const observation = await readDesktopSession({ execFileImpl: executor.run });
  assert.equal(observation.sessionAvailable, false);
  assert.equal(observation.onConsole, null);
  assert.equal(observation.loginDone, null);
  assert.equal(observation.screenLocked, null);
  assert.throws(() => assertInteractiveDesktopSession(observation), {
    code: "desktop-session-unavailable",
  });
  await assertOwnCacheRemoved(executor);
});

test("a parsed locked session is rejected even when all other facts are ready", async () => {
  const executor = executorReturning(rawJson({ screenLocked: true }));
  const observation = await readDesktopSession({ execFileImpl: executor.run });
  assert.equal(observation.sessionAvailable, true);
  assert.equal(observation.onConsole, true);
  assert.equal(observation.loginDone, true);
  assert.equal(observation.screenLocked, true);
  assert.throws(() => assertInteractiveDesktopSession(observation), {
    code: "desktop-session-locked",
  });
  await assertOwnCacheRemoved(executor);
});

test("rejects missing, extra, malformed, and incorrectly typed Swift output and still cleans its cache", async (t) => {
  const invalidOutputs = [
    ["missing field", JSON.stringify({ ...unlockedSession, screenLocked: undefined })],
    ["extra field", JSON.stringify({ ...unlockedSession, anotherFact: false })],
    ["wrong type", rawJson({ loginDone: "true" })],
    ["malformed JSON", "{not-json"],
    ["over limit", " ".repeat(4_097)],
  ];
  for (const [name, output] of invalidOutputs) {
    await t.test(name, async () => {
      const executor = executorReturning(output);
      await assert.rejects(
        readDesktopSession({ execFileImpl: executor.run }),
        { code: "desktop-session-output-invalid" },
      );
      await assertOwnCacheRemoved(executor);
    });
  }
});

test("maps timeout to a fixed error and removes its private cache", async () => {
  const executor = executorReturning("", { error: Object.assign(new Error("private detail"), { code: "ETIMEDOUT" }) });
  await assert.rejects(
    readDesktopSession({ execFileImpl: executor.run }),
    (error) => error.code === "desktop-session-query-timeout"
      && error.message === "desktop-session-query-timeout",
  );
  await assertOwnCacheRemoved(executor);
});

test("rejects invalid observation shapes and timestamps", () => {
  const valid = { ...unlockedSession, observedAt: "2026-10-29T12:00:00.000Z" };
  assert.throws(() => assertInteractiveDesktopSession({ ...valid, extra: true }), {
    code: "desktop-session-observation-invalid",
  });
  assert.throws(() => assertInteractiveDesktopSession({ ...valid, observedAt: "not-a-time" }), {
    code: "desktop-session-observation-invalid",
  });
});
