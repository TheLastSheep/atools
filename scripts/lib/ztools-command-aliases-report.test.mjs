import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_ALIASES_ERRORS,
  COMMAND_ALIASES_REPORT_FILENAME,
  readCommandAliasesReport,
  validateCommandAliasesReport,
} from "./ztools-command-aliases-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};

function validReport() {
  return {
    schemaVersion: 1, journey: "settings-command-aliases", scope: "hidden-original-vue-command-aliases",
    ...owner,
    observations: {
      initialStateValid: true, addMenuDispatched: true, addDialogOpened: true, addSaveDispatched: true,
      addStored: true, addMainMatched: true, editSaveDispatched: true, editStored: true, editMainUpdated: true,
      closedAfterEdit: true, freshSessionOnReopen: true, reopenReadBack: true, deleteDialogOpened: true,
      deleteConfirmed: true, deleteStored: true, deleteMainExcluded: true, unrelatedPreserved: true,
      noAppCatalogReload: true, pluginUiOpened: false, preloadStarted: false,
      aliasEventsBefore: 0, aliasEventsAfterAdd: 1, aliasEventsAfterEdit: 2, aliasEventsAfterDelete: 3,
      appListReadsBefore: 4, appListReadsAfter: 4,
      addMatchCount: 1, editOldMatchCount: 0, editNewMatchCount: 1, deleteMatchCount: 0,
    },
    errors: [],
  };
}

test("derives pass from exact command alias transitions and the expected Native owner", () => {
  const result = validateCommandAliasesReport(validReport(), owner);
  assert.equal(COMMAND_ALIASES_REPORT_FILENAME, "native-command-aliases-report.json");
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.passed, true);
});

test("rejects a mismatched owner even when every observation passes", () => {
  const report = validReport();
  report.pid += 1;
  const result = validateCommandAliasesReport(report, owner);
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
});

test("rejects unknown fields and any forged Native passed bit", () => {
  for (const mutate of [
    report => { report.extra = true; },
    report => { report.passed = true; },
    report => { report.observations.extra = true; },
  ]) {
    const result = validateCommandAliasesReport(mutateAndGet(mutate), owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }
});

test("retains nullable failure facts but never passes unknown observations", () => {
  const report = validReport();
  report.observations.editStored = null;
  const result = validateCommandAliasesReport(report, owner);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.equal(result.summary.observations.editStored, null);
});

test("requires monotonic event changes, stable app-list reads, and exact search counts", () => {
  for (const mutate of [
    report => { report.observations.aliasEventsAfterEdit = 1; },
    report => { report.observations.aliasEventsAfterDelete = report.observations.aliasEventsAfterEdit - 1; },
    report => { report.observations.appListReadsAfter += 1; },
    report => { report.observations.aliasEventsBefore = null; },
    report => { report.observations.appListReadsBefore = null; report.observations.appListReadsAfter = null; },
    report => { report.observations.deleteMatchCount = 1; },
    report => { report.observations.editOldMatchCount = null; },
    report => { report.observations.aliasEventsAfterAdd = 4097; },
  ]) {
    const result = validateCommandAliasesReport(mutateAndGet(mutate), owner);
    assert.equal(result.passed, false);
  }
});

test("accepts only known unique Native errors and any error blocks pass", () => {
  const known = validReport();
  known.errors = [COMMAND_ALIASES_ERRORS[0]];
  assert.equal(validateCommandAliasesReport(known, owner).valid, true);
  assert.equal(validateCommandAliasesReport(known, owner).passed, false);

  for (const errors of [
    ["settings-command-aliases-unrecognized"],
    [COMMAND_ALIASES_ERRORS[0], COMMAND_ALIASES_ERRORS[0]],
    [new Array(1)],
  ]) {
    const report = validReport();
    report.errors = errors;
    const result = validateCommandAliasesReport(report, owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }
});

test("missing and malformed sidecars fail, and a valid report still needs terminal Native success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-command-aliases-"));
  try {
    const missing = await readCommandAliasesReport(join(directory, "missing.json"), owner, true, true);
    assert.equal(missing.exists, false);
    assert.equal(missing.passed, false);
    const malformedPath = join(directory, COMMAND_ALIASES_REPORT_FILENAME);
    await writeFile(malformedPath, "{", { mode: 0o600 });
    const malformed = await readCommandAliasesReport(malformedPath, owner, true, true);
    assert.equal(malformed.exists, true);
    assert.equal(malformed.passed, false);
    await writeFile(malformedPath, JSON.stringify(validReport()), { mode: 0o600 });
    const nonterminal = await readCommandAliasesReport(malformedPath, owner, true, false);
    assert.equal(nonterminal.valid, false);
    assert.equal(nonterminal.passed, false);
    const wrongNativeOwner = await readCommandAliasesReport(malformedPath, owner, false, true);
    assert.equal(wrongNativeOwner.valid, false);
    assert.equal(wrongNativeOwner.passed, false);
    await writeFile(malformedPath, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
    const oversized = await readCommandAliasesReport(malformedPath, owner, true, true);
    assert.equal(oversized.exists, true);
    assert.equal(oversized.passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function mutateAndGet(mutate) {
  const report = validReport();
  mutate(report);
  return report;
}
