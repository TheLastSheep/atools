import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  requiredSmokeCases,
  verifyPasteboardProReleaseEvidence,
} from "./pasteboardpro-release-evidence.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "pasteboardpro-release-evidence-"));
const write = async (name, value) => {
  const file = path.join(root, name);
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
  return file;
};

const search = (implementation) => ({
  schemaVersion: 1,
  pass: true,
  runtime: { implementation },
  methodology: { warmupRuns: 3, measuredRuns: 40, percentile: 95 },
  results: [10_000, 100_000].map((itemCount) => ({
    itemCount,
    thresholdMs: itemCount === 10_000 ? 50 : 150,
    p95Ms: itemCount === 10_000 ? 8 : 40,
    pass: true,
    queries: Array.from({ length: 4 }, (_, index) => ({ query: `${index}`, p95Ms: 8 })),
  })),
});

const evidenceBytes = Buffer.from("pasteboardpro-smoke-evidence");
const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");

const smoke = (host) => ({
  schemaVersion: 1,
  fixtureVersion: "pasteboardpro-macos-smoke-v1",
  host,
  pass: true,
  platform: "darwin",
  architecture: "arm64",
  appVersion: "1.0.0",
  commitSha: "a".repeat(40),
  packageSha256: "b".repeat(64),
  recordedAt: "2026-07-17T00:00:00.000Z",
  cases: requiredSmokeCases.map((id) => ({
    id,
    status: "pass",
    evidence: [{ kind: "log", path: `${host}-smoke-evidence.log`, sha256: evidenceSha256 }],
  })),
});

try {
  await writeFile(path.join(root, "atools-smoke-evidence.log"), evidenceBytes);
  await writeFile(path.join(root, "ztools-smoke-evidence.log"), evidenceBytes);
  const paths = {
    crossHost: await write("cross-host.json", {
      schemaVersion: 1,
      fixtureVersion: "pasteboardpro-cross-host-v1",
      pass: true,
      hosts: { rust: "ATools sync_pasteboard_vault", node: "ZTools syncZToolsVault" },
      plaintextLeaks: [],
      retries: { etag412: 1, fixtureConditionalConflicts: 1 },
      faults: {
        injectedResponses: 3,
        interruptedUploads: 1,
        corruptedFiles: 1,
        authRequired: "auth_required",
        offline: "offline",
        corrupted: "corrupted",
      },
      objectCounts: { remoteFiles: 8, encryptedObjects: 5 },
      requests: { total: 30 },
    }),
    atoolsSearch: await write("atools-search.json", search("ATools")),
    ztoolsSearch: await write("ztools-search.json", search("ZTools")),
    visual: await write("visual.json", {
      schemaVersion: 1,
      pass: true,
      matrixStates: 32,
      screenshots: 72,
      records: Array.from({ length: 72 }, (_, index) => ({
        screenshot: `host/${index}.png`,
        consoleErrors: [],
      })),
    }),
    archive: await write("archive.json", {
      schemaVersion: 1,
      archive: "pasteboard-pro-1.0.0.zip",
      archiveSha256: "c".repeat(64),
      helperSha256: "d".repeat(64),
      fileCount: 8,
      manifest: { name: "pasteboard-pro" },
      checks: {
        rootLayout: true,
        safeEntries: true,
        executableHelper: true,
        noForbiddenFiles: true,
        noDevelopmentPaths: true,
        helperAttestation: {
          checked: true,
          sha256: "d".repeat(64),
          expectedSignature: "developer-id",
          hardenedRuntime: true,
          teamIdentifier: "ABCDE12345",
          authorities: ["Developer ID Application: Example Corp (ABCDE12345)"],
          gatekeeper: { checked: true, accepted: true },
        },
      },
    }),
    atoolsSmoke: await write("atools-smoke.json", smoke("atools")),
    ztoolsSmoke: await write("ztools-smoke.json", smoke("ztools")),
  };

  const outputPath = path.join(root, "release-evidence.json");
  const summary = await verifyPasteboardProReleaseEvidence(paths, { outputPath });
  assert.equal(summary.pass, true);
  assert.equal(summary.checks.atoolsSmoke.cases, requiredSmokeCases.length);
  assert.equal(Object.keys(summary.evidenceSha256).length, 7);

  const incompleteSmoke = smoke("ztools");
  incompleteSmoke.cases.pop();
  paths.ztoolsSmoke = await write("ztools-smoke-incomplete.json", incompleteSmoke);
  await assert.rejects(
    verifyPasteboardProReleaseEvidence(paths),
    /smoke report is missing/u,
  );

  console.log("PasteboardPro unified release evidence verifier tested");
} finally {
  await rm(root, { recursive: true, force: true });
}
