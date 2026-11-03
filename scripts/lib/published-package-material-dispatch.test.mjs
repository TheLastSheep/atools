import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPackageMaterialDispatcher, PINNED_HEAD_PACKAGE_CASES } from "./published-package-material-dispatch.mjs";

const cases = [
  ["local-calculation-paper-head", "calculation-paper"],
  ["local-mybatis-sql-formatter-head", "mybatis-sql-formatter"],
  ["local-random-data-head", "random-data"],
  ["local-image-stitch-head", "image-stitch"],
];

function dispatcherWith(headPackages, calls) {
  return createPackageMaterialDispatcher({
    verifyHead: async (caseId, fixture, profile) => { calls.push(["head", caseId, fixture, profile]); return { verification: { caseId } }; },
    verifyLocal: async (fixture, profile) => { calls.push(["local", fixture, profile]); return "local"; },
    verifyArchive: async (fixture, profile) => { calls.push(["archive", fixture, profile]); return "archive"; },
    verifyPublished: async (fixture, expected) => { calls.push(["published", fixture, expected]); return "published"; },
    headPackages,
  });
}

test("routes all pinned HEAD package cases, including Image Stitch, through their registered material verifier", async () => {
  assert.deepEqual(PINNED_HEAD_PACKAGE_CASES, cases.map(([caseId, packagePath]) => ({ caseId, packagePath })));
  const calls = [];
  const headPackages = cases.map(([caseId, packagePath]) => ({
    caseId, packagePath, read: () => ({ commit: "a".repeat(40), files: new Map() }),
  }));
  const dispatcher = dispatcherWith(headPackages, calls);
  for (const [caseId] of cases) {
    const fixture = { caseId }, profile = { caseId, sourceKind: "local_full_directory" };
    assert.deepEqual(await dispatcher.verify(fixture, profile), { verification: { caseId } });
  }
  assert.deepEqual(calls, cases.map(([caseId]) => ["head", caseId, { caseId }, { caseId, sourceKind: "local_full_directory" }]));
});

test("preserves exact HEAD source witness paths and hashes for every package file", () => {
  const bytes = Buffer.from("registered HEAD blob");
  const imageStitchFiles = ["app.js", "index.html", "logo.svg", "plugin.json", "style.css"];
  const headPackages = cases.map(([caseId, packagePath]) => ({
    caseId, packagePath, read: () => ({ commit: "b".repeat(40),
      files: new Map((caseId === "local-image-stitch-head" ? imageStitchFiles : ["plugin.json", "index.html"]).map(file => [file, bytes])) }),
  }));
  const dispatcher = dispatcherWith(headPackages, []);
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const actual = dispatcher.sourceWitness({ caseId: "local-image-stitch-head" });
  assert.deepEqual(actual, imageStitchFiles.map(file => [`HEAD/${"b".repeat(40)}/plugins/image-stitch/${file}`, expectedHash]));
  assert.equal(actual.length, 5);
});

test("keeps generic local, archive, and published package material routes unchanged", async () => {
  const calls = [], dispatcher = dispatcherWith([], calls), fixture = { fixture: true };
  assert.equal(await dispatcher.verify(fixture, { sourceKind: "local_full_directory" }), "local");
  assert.equal(await dispatcher.verify(fixture, { sourceKind: "local_original_archive" }), "archive");
  assert.equal(await dispatcher.verify(fixture, { sourceKind: "converted_handoff_directory" }, "expected-sha"), "published");
  assert.deepEqual(calls, [
    ["local", fixture, { sourceKind: "local_full_directory" }],
    ["archive", fixture, { sourceKind: "local_original_archive" }],
    ["published", fixture, "expected-sha"],
  ]);
  assert.deepEqual(dispatcher.sourceWitness({ caseId: "not-a-head-case" }), []);
});
