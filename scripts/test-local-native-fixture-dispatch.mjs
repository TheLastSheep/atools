import assert from "node:assert/strict";
import test from "node:test";
import { prepareLocalNativeFixture } from "./lib/local-native-fixture-dispatch.mjs";

test("fixed Random Data HEAD dispatch reads its registered profile and never reaches dirty-source fallback", async () => {
  const calls = [];
  const profile = { caseId: "local-random-data-head", sourceCommit: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d" };
  const prepared = { profile, fixture: { sourceKind: "local_full_directory" } };
  const providers = {
    readProfile: async caseId => { calls.push(["profile", caseId]); return profile; },
    prepareCalculation: async () => { throw Error("wrong HEAD adapter"); },
    prepareMybatis: async () => { throw Error("wrong HEAD adapter"); },
    prepareRandomData: async (value, options) => { calls.push(["random", value, options]); return prepared; },
    prepareArchive: async () => { throw Error("wrong archive adapter"); },
    prepareGeneric: async () => { throw Error("dirty-worktree fallback reached"); },
  };
  assert.equal(await prepareLocalNativeFixture("local-random-data-head", { temporaryParent: "/private/tmp" }, providers), prepared);
  assert.deepEqual(calls, [["profile", "local-random-data-head"], ["random", profile, { temporaryParent: "/private/tmp" }]]);
});

test("unrelated registered local case retains its existing generic adapter route", async () => {
  const calls = [];
  const expected = { fixture: "generic" };
  const providers = { prepareGeneric: async (caseId, options) => { calls.push([caseId, options]); return expected; } };
  assert.equal(await prepareLocalNativeFixture("local-existing-fixture", { temporaryParent: "/private/tmp" }, providers), expected);
  assert.deepEqual(calls, [["local-existing-fixture", { temporaryParent: "/private/tmp" }]]);
});

test("fixed Image Stitch HEAD dispatches only its pinned reader and never generic dirty source", async () => {
  const calls = [];
  const profile = { caseId: "local-image-stitch-head", sourceCommit: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d" };
  const prepared = { profile, fixture: { sourceKind: "local_full_directory" } };
  const providers = {
    readProfile: async caseId => { calls.push(["profile", caseId]); return profile; },
    prepareImageStitch: async (value, options) => { calls.push(["image-stitch", value, options]); return prepared; },
    prepareGeneric: async () => { throw Error("dirty-worktree fallback reached"); },
  };
  assert.equal(await prepareLocalNativeFixture("local-image-stitch-head", { temporaryParent: "/private/tmp" }, providers), prepared);
  assert.deepEqual(calls, [["profile", "local-image-stitch-head"], ["image-stitch", profile, { temporaryParent: "/private/tmp" }]]);
});
