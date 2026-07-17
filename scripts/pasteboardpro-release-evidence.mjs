import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const requiredSmokeCases = [
  "activation-restart",
  "capture-text",
  "capture-rich-text",
  "capture-html",
  "capture-url",
  "capture-image",
  "capture-pdf",
  "capture-color",
  "capture-files",
  "quick-paste",
  "quick-paste-plain-text",
  "paste-stack",
  "multi-select-order",
  "pinboards",
  "ocr-success",
  "ocr-permission-denied",
  "ocr-helper-timeout",
  "quick-look",
  "dock-and-edge-radii",
  "multi-monitor-recovery",
  "screen-share-protection",
  "privacy-bundle-rule",
  "privacy-content-rule",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readEvidence(filePath) {
  const absolutePath = path.resolve(filePath);
  const bytes = await readFile(absolutePath);
  return { path: absolutePath, report: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
}

function verifySearch(report, implementation) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.pass, true, `${implementation} search report failed`);
  assert.equal(report.methodology?.warmupRuns, 3);
  assert.equal(report.methodology?.measuredRuns, 40);
  assert.equal(report.methodology?.percentile, 95);
  assert.equal(Array.isArray(report.results), true);
  assert.equal(report.results.length, 2);
  const expected = new Map([
    [10_000, 50],
    [100_000, 150],
  ]);
  for (const result of report.results) {
    assert.equal(result.thresholdMs, expected.get(result.itemCount));
    assert.equal(result.pass, true);
    assert.ok(result.p95Ms <= result.thresholdMs, `${implementation} ${result.itemCount} P95 exceeded`);
    assert.equal(result.queries?.length, 4);
    assert.equal(result.queries.every((query) => query.p95Ms <= result.thresholdMs), true);
  }
  return Object.fromEntries(report.results.map((result) => [result.itemCount, result.p95Ms]));
}

function verifyCrossHost(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.fixtureVersion, "pasteboardpro-cross-host-v1");
  assert.equal(report.pass, true);
  assert.equal(report.hosts?.rust, "ATools sync_pasteboard_vault");
  assert.equal(report.hosts?.node, "ZTools syncZToolsVault");
  assert.deepEqual(report.plaintextLeaks, []);
  assert.ok(report.retries?.etag412 >= 1);
  assert.ok(report.retries?.fixtureConditionalConflicts >= 1);
  assert.ok(report.faults?.injectedResponses >= 1);
  assert.ok(report.faults?.interruptedUploads >= 1);
  assert.ok(report.faults?.corruptedFiles >= 1);
  assert.equal(report.faults?.authRequired, "auth_required");
  assert.equal(report.faults?.offline, "offline");
  assert.equal(report.faults?.corrupted, "corrupted");
  return {
    remoteFiles: report.objectCounts?.remoteFiles,
    encryptedObjects: report.objectCounts?.encryptedObjects,
    requests: report.requests?.total,
  };
}

function verifyVisual(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.pass, true);
  assert.equal(report.matrixStates, 32);
  assert.equal(report.screenshots, 72);
  assert.equal(report.records?.length, 72);
  assert.equal(new Set(report.records.map((record) => record.screenshot)).size, 72);
  assert.equal(report.records.every((record) => record.consoleErrors?.length === 0), true);
  return { matrixStates: 32, screenshots: 72 };
}

function verifyArchive(report) {
  assert.equal(report.schemaVersion, 1);
  assert.match(report.archiveSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.match(report.helperSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(report.manifest?.name, "pasteboard-pro");
  for (const check of [
    "rootLayout",
    "safeEntries",
    "executableHelper",
    "noForbiddenFiles",
    "noDevelopmentPaths",
  ]) {
    assert.equal(report.checks?.[check], true, `Archive check ${check} failed`);
  }
  const attestation = report.checks?.helperAttestation;
  assert.equal(attestation?.checked, true);
  assert.equal(attestation?.sha256, report.helperSha256);
  assert.equal(attestation?.expectedSignature, "developer-id");
  assert.equal(attestation?.hardenedRuntime, true);
  assert.match(attestation?.teamIdentifier ?? "", /^[A-Z0-9]{10}$/u);
  assert.ok(attestation?.authorities?.some((authority) => authority.startsWith("Developer ID Application:")));
  assert.deepEqual(attestation?.gatekeeper, { checked: true, accepted: true });
  return {
    archive: report.archive,
    archiveSha256: report.archiveSha256,
    helperSha256: report.helperSha256,
    fileCount: report.fileCount,
  };
}

async function verifySmoke(report, expectedHost, reportPath) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.fixtureVersion, "pasteboardpro-macos-smoke-v1");
  assert.equal(report.host, expectedHost);
  assert.equal(report.pass, true, `${expectedHost} smoke report failed`);
  assert.equal(report.platform, "darwin");
  assert.ok(["arm64", "x86_64"].includes(report.architecture));
  assert.match(report.commitSha ?? "", /^[a-f0-9]{40}$/u);
  assert.match(report.packageSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(Number.isNaN(Date.parse(report.recordedAt)), false);
  assert.equal(Array.isArray(report.cases), true);
  const cases = new Map(report.cases.map((entry) => [entry.id, entry]));
  assert.equal(cases.size, report.cases.length, `${expectedHost} smoke case ids must be unique`);
  for (const id of requiredSmokeCases) {
    const entry = cases.get(id);
    assert.ok(entry, `${expectedHost} smoke report is missing ${id}`);
    assert.equal(entry.status, "pass", `${expectedHost} smoke case ${id} did not pass`);
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.length > 0, `${id} has no evidence`);
    for (const evidence of entry.evidence) {
      assert.ok(["screenshot", "video", "log", "measurement"].includes(evidence?.kind));
      assert.equal(typeof evidence?.path, "string");
      assert.equal(path.isAbsolute(evidence.path), false, `${id} evidence path must be relative`);
      assert.equal(evidence.path.includes("\\"), false, `${id} evidence path uses a backslash`);
      assert.equal(evidence.path.split("/").includes(".."), false, `${id} evidence escapes its report directory`);
      assert.match(evidence.sha256 ?? "", /^[a-f0-9]{64}$/u);
      const evidenceBytes = await readFile(
        path.join(path.dirname(reportPath), ...evidence.path.split("/")),
      );
      assert.equal(sha256(evidenceBytes), evidence.sha256, `${id} evidence SHA-256 mismatch`);
    }
  }
  return {
    host: expectedHost,
    architecture: report.architecture,
    appVersion: report.appVersion,
    commitSha: report.commitSha,
    packageSha256: report.packageSha256,
    cases: requiredSmokeCases.length,
  };
}

export async function verifyPasteboardProReleaseEvidence(paths, options = {}) {
  const keys = [
    "crossHost",
    "atoolsSearch",
    "ztoolsSearch",
    "visual",
    "archive",
    "atoolsSmoke",
    "ztoolsSmoke",
  ];
  for (const key of keys) assert.ok(paths[key], `Missing ${key} evidence path`);
  const entries = await Promise.all(keys.map((key) => readEvidence(paths[key])));
  const evidence = Object.fromEntries(keys.map((key, index) => [key, entries[index]]));

  const summary = {
    schemaVersion: 1,
    fixtureVersion: "pasteboardpro-release-evidence-v1",
    generatedAt: new Date().toISOString(),
    pass: true,
    checks: {
      crossHost: verifyCrossHost(evidence.crossHost.report),
      atoolsSearch: verifySearch(evidence.atoolsSearch.report, "ATools SQLite"),
      ztoolsSearch: verifySearch(evidence.ztoolsSearch.report, "ZTools shared query"),
      visual: verifyVisual(evidence.visual.report),
      archive: verifyArchive(evidence.archive.report),
      atoolsSmoke: await verifySmoke(
        evidence.atoolsSmoke.report,
        "atools",
        evidence.atoolsSmoke.path,
      ),
      ztoolsSmoke: await verifySmoke(
        evidence.ztoolsSmoke.report,
        "ztools",
        evidence.ztoolsSmoke.path,
      ),
    },
    evidenceSha256: Object.fromEntries(keys.map((key) => [key, evidence[key].sha256])),
  };
  if (options.outputPath) {
    await writeFile(path.resolve(options.outputPath), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  return summary;
}

function parseArgs(args) {
  return Object.fromEntries(
    args
      .filter((argument) => argument.startsWith("--") && argument.includes("="))
      .map((argument) => {
        const [key, ...value] = argument.slice(2).split("=");
        return [key, value.join("=")];
      }),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  const summary = await verifyPasteboardProReleaseEvidence(
    {
      crossHost: args["cross-host"],
      atoolsSearch: args["atools-search"],
      ztoolsSearch: args["ztools-search"],
      visual: args.visual,
      archive: args.archive,
      atoolsSmoke: args["atools-smoke"],
      ztoolsSmoke: args["ztools-smoke"],
    },
    { outputPath: args.output },
  );
  console.log(
    `PasteboardPro release evidence verified (${summary.checks.atoolsSmoke.cases * 2} host smoke cases)`,
  );
}
