import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  NATIVE_MATERIAL_SCOPE,
  NATIVE_MATERIAL_STAGES,
  validateNativeMaterialReport,
} from "./ztools-native-material-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};
const snapshots = {
  light: { state: "unverified", filename: null, reason: "settings-input-snapshot-requires-macos", evidence: null, readiness: null },
  dark: { state: "unverified", filename: null, reason: "settings-input-snapshot-timeout", evidence: null, readiness: null },
};
const readySnapshot = {
  routeGeneral: true, mediaMatches: true, menusAbsent: true, rootTextMatches: true,
  sidebarTextMatches: true, labelTextMatches: true, framesObserved: true, settled: true,
};

function observation(child = false) {
  const leases = Number(child);
  return {
    supported: true, installed: true, mainOwner: true, settingsLeaseCount: leases, totalOwners: 1 + leases,
    cleanupPending: false, effectCount: 1, tag: 91_376_254, material: 15,
    blendingMode: 0, state: 0, effectiveAppearance: "dark",
  };
}

function stage(key) {
  const child = !["startup", "closeCleanup", "finalCleanup"].includes(key);
  return {
    key, elapsedMs: 4, passed: true, actual: observation(child), errors: [],
    childDrawsBackground: child ? false : null,
  };
}

function themeReport() {
  const generalEntry = {
    routeGeneral: true, sidebarFound: true, navigationDispatched: true, themeControlFound: true,
    selectedTheme: "dark", childCommittedTheme: "dark", childMediaDark: true, passed: true,
  };
  const initial = {
    databaseTheme: "dark", routeAllCommands: true, childCommittedTheme: "dark", childMediaDark: true,
    mainMediaDark: true, effectiveAppearance: "dark", passed: true, generalEntry,
  };
  const steps = [
    { theme: "light", appearance: "light" },
    { theme: "dark", appearance: "dark" },
    // `system` is compared to the effective appearance observed from the native window.
    { theme: "system", appearance: "light" },
  ].map(({ theme, appearance }) => ({
    theme, routeGeneral: true, themeControlFound: true, themeMenuOpened: true, optionSetValid: true,
    selectionDispatched: true, selected: true, selectedTheme: theme, childCommittedTheme: theme,
    databaseTheme: theme, childMediaDark: appearance === "dark", mainMediaDark: appearance === "dark",
    effectiveAppearance: appearance, passed: true,
  }));
  return {
    passed: true,
    initial,
    steps,
    restoration: {
      theme: "dark", routeGeneral: true, selectedTheme: "dark", childCommittedTheme: "dark",
      databaseTheme: "dark", childMediaDark: true, mainMediaDark: true, effectiveAppearance: "dark",
      matchesInitialAppearance: true, passed: true,
    },
  };
}

function validReport() {
  return {
    schemaVersion: 1, journey: "settings-input-material", scope: NATIVE_MATERIAL_SCOPE,
    identifier: owner.identifier, root: owner.root, pid: owner.pid, runId,
    // Deliberately false: acceptance is derived from evidence, not this Native summary bit.
    passed: false, elapsedMs: 120, stages: NATIVE_MATERIAL_STAGES.map(stage),
    paintDiagnostics: { light: null, dark: null },
    theme: themeReport(), snapshots: structuredClone(snapshots),
    cleanup: {
      stopAcknowledged: true, passed: true,
      actual: {
        supported: true, installed: true, mainOwner: false, settingsLeaseCount: 0, totalOwners: 0,
        cleanupPending: false, effectCount: 0, tag: null, material: null,
        blendingMode: null, state: null, effectiveAppearance: "dark",
      },
    },
    errors: [],
  };
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const body = Buffer.concat([typeBytes, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(testCrc32(body));
  return Buffer.concat([header, body, checksum]);
}

function png({ width = 16, height = 16, colorOffset = 0 } = {}) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = (x + colorOffset) % 255;
      pixels[offset + 1] = y % 255;
      pixels[offset + 2] = 127;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    signature, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function testCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function capturedSnapshot(theme, bytes, filename = `native-general-${theme}.png`, width = 16, height = 16) {
  return {
    state: "captured", filename, reason: null, readiness: structuredClone(readySnapshot),
    evidence: {
      width, height, pngBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      nonUniform: true, nonTransparent: true,
    },
  };
}

async function withDirectory(callback) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atools-native-material-")));
  try { await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("derives twelve-stage material and theme success from evidence, not Native passed", async () => {
  const result = await validateNativeMaterialReport(validReport(), owner, tmpdir());
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.visual.status, "unverified");
  assert.equal(result.visual.passed, false);
  assert.deepEqual(result.paintDiagnostics, {
    light: { state: "unverified", reason: "diagnostics-unavailable" },
    dark: { state: "unverified", reason: "diagnostics-unavailable" },
  });
  assert.equal(result.errors.length, 0);
});

test("requires explicit paint diagnostics but does not upgrade the visual gate", async () => {
  const missing = validReport();
  delete missing.paintDiagnostics;
  const invalid = await validateNativeMaterialReport(missing, owner, tmpdir());
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes("report-shape"));
  assert.ok(invalid.errors.includes("paint-diagnostics-shape"));

  const report = validReport();
  report.paintDiagnostics = {
    light: null,
    dark: {
      nativeSchedulingPolicy: "throttle",
      observations: {
        documentHidden: true,
        before: {
          sidebar: {
            generalUnique: true, generalActive: true, generalColorComparable: true,
            generalColorUsesPrimary: true, shortcutUnique: true, shortcutInactive: true,
            shortcutColorComparable: true, shortcutColorUsesText: true,
          },
          menus: { total: 0, body: 0, theme: 0, leave: 0, enter: 0, ownersOpen: 0, visible: 0 },
        },
        after: {
          sidebar: {
            generalUnique: true, generalActive: true, generalColorComparable: true,
            generalColorUsesPrimary: true, shortcutUnique: true, shortcutInactive: true,
            shortcutColorComparable: true, shortcutColorUsesText: true,
          },
          menus: { total: 0, body: 0, theme: 0, leave: 0, enter: 0, ownersOpen: 0, visible: 0 },
        },
        rafCallbacks: 0,
        elapsedMs: 2000,
        timedOut: true,
      },
    },
  };
  const result = await validateNativeMaterialReport(report, owner, tmpdir());
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.paintDiagnostics.dark.state, "observed");
  assert.equal(result.paintDiagnostics.dark.nativeSchedulingPolicy, "throttle");
  assert.equal(result.paintDiagnostics.light.state, "unverified");
  assert.equal(result.visual.status, "unverified");
  assert.equal(result.visual.passed, false);
});

test("rejects missing, duplicate, reordered, and zero-elapsed stages", async () => {
  for (const mutate of [
    value => { value.stages.pop(); },
    value => { value.stages[2] = structuredClone(value.stages[1]); },
    value => { [value.stages[2], value.stages[3]] = [value.stages[3], value.stages[2]]; },
    value => { value.stages[2].elapsedMs = 0; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  }
});

test("requires the active child webview background to be transparent and absent children to report null", async () => {
  assert.equal((await validateNativeMaterialReport(validReport(), owner, tmpdir())).valid, true);
  for (const mutate of [
    value => { delete value.stages[1].childDrawsBackground; },
    value => { value.stages[1].childDrawsBackground = null; },
    value => { value.stages[1].childDrawsBackground = true; },
    value => { delete value.stages[0].childDrawsBackground; },
    value => { value.stages[0].childDrawsBackground = false; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  }
});

test("rejects owner, material, lease, and final-cleanup mismatches", async () => {
  for (const mutate of [
    value => { value.pid += 1; },
    value => { value.stages[1].actual.material = 14; },
    value => { value.stages[1].actual.totalOwners = 1; },
    value => { value.cleanup.actual.cleanupPending = true; },
    value => { value.cleanup.actual.effectCount = 1; },
    value => { value.cleanup.stopAcknowledged = false; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  }
});

test("requires initial dark theme, ordered theme cycle, actual system appearance, and restoration", async () => {
  for (const mutate of [
    value => { value.theme.initial.databaseTheme = "light"; },
    value => { value.theme.steps[0].selected = false; },
    value => { value.theme.steps[2].childMediaDark = true; },
    value => { value.theme.restoration.databaseTheme = "light"; },
    value => { value.theme.restoration.matchesInitialAppearance = false; },
    value => { value.theme.steps.reverse(); },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  }
});

test("requires explicit fixed-code unverified snapshot evidence without failing material verification", async () => {
  const report = validReport();
  report.snapshots.light.reason = "not-a-native-error-code";
  const invalid = await validateNativeMaterialReport(report, owner, tmpdir());
  assert.equal(invalid.valid, false);

  report.snapshots.light.reason = "settings-input-snapshot-requires-macos";
  const valid = await validateNativeMaterialReport(report, owner, tmpdir());
  assert.equal(valid.valid, true);
  assert.equal(valid.passed, true);
  assert.equal(valid.visual.passed, false);
});

test("accepts an explicit unsettled snapshot only with a complete false-settled readiness record", async () => {
  const report = validReport();
  report.snapshots.light = {
    state: "unverified", filename: null, reason: "settings-input-material-snapshot-unsettled",
    evidence: null,
    readiness: { ...readySnapshot, menusAbsent: false, settled: false },
  };
  const result = await validateNativeMaterialReport(report, owner, tmpdir());
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.visual.passed, false);

  report.snapshots.light.readiness.settled = true;
  assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  report.snapshots.light.readiness = { ...readySnapshot, settled: false };
  assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  report.snapshots.light.readiness = { ...readySnapshot, menusAbsent: false, settled: false };
  assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, true);
  report.snapshots.light.readiness = { ...readySnapshot, mediaMatches: 1, settled: false };
  assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
  report.snapshots.light.readiness = { ...readySnapshot, settled: false };
  delete report.snapshots.light.readiness.framesObserved;
  assert.equal((await validateNativeMaterialReport(report, owner, tmpdir())).valid, false);
});

test("rejects captured snapshots whose readiness is missing, incomplete, false, or inconsistent", async () => {
  await withDirectory(async directory => {
    const bytes = png();
    const report = validReport();
    report.snapshots.light = capturedSnapshot("light", bytes);
    await writeFile(join(directory, "native-general-light.png"), bytes);
    for (const readiness of [
      null,
      { ...readySnapshot, settled: false },
      { ...readySnapshot, routeGeneral: false },
      { ...readySnapshot, extra: true },
      Object.fromEntries(Object.entries(readySnapshot).filter(([key]) => key !== "framesObserved")),
    ]) {
      report.snapshots.light.readiness = readiness;
      assert.equal((await validateNativeMaterialReport(report, owner, directory)).valid, false);
    }
  });
});

test("checks captured PNG filename, no-follow file, byte size, dimensions, and SHA-256", async () => {
  await withDirectory(async directory => {
    const light = png({ colorOffset: 1 });
    const dark = png({ colorOffset: 2 });
    const report = validReport();
    report.snapshots.light = capturedSnapshot("light", light);
    report.snapshots.dark = capturedSnapshot("dark", dark);
    await writeFile(join(directory, "native-general-light.png"), light, { mode: 0o600 });
    await writeFile(join(directory, "native-general-dark.png"), dark, { mode: 0o600 });
    let result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.visual.passed, true);

    report.snapshots.light.filename = "../native-general-light.png";
    result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, false);
    report.snapshots.light = capturedSnapshot("light", light);
    report.snapshots.light.evidence.sha256 = "0".repeat(64);
    result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, false);
    report.snapshots.light = capturedSnapshot("light", light);
    report.snapshots.light.evidence.width = 17;
    result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, false);
    const oversizedDimensions = png({ width: 4097, height: 16 });
    report.snapshots.light = capturedSnapshot("light", oversizedDimensions, undefined, 4097, 16);
    await writeFile(join(directory, "native-general-light.png"), oversizedDimensions);
    result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, false);
  });
});

test("rejects symlinked or oversized captured files", async () => {
  await withDirectory(async directory => {
    const bytes = png();
    const report = validReport();
    report.snapshots.light = capturedSnapshot("light", bytes);
    report.snapshots.dark = structuredClone(snapshots.dark);
    const target = join(directory, "target.png");
    await writeFile(target, bytes);
    await symlink(target, join(directory, "native-general-light.png"));
    let result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, false);

    await rm(join(directory, "native-general-light.png"));
    await writeFile(join(directory, "native-general-light.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, false);
  });
});

test("identical captured themes remain valid evidence but are explicitly not a two-theme visual pass", async () => {
  await withDirectory(async directory => {
    const bytes = png();
    const report = validReport();
    report.snapshots.light = capturedSnapshot("light", bytes);
    report.snapshots.dark = capturedSnapshot("dark", bytes);
    await writeFile(join(directory, "native-general-light.png"), bytes);
    await writeFile(join(directory, "native-general-dark.png"), bytes);
    const result = await validateNativeMaterialReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.equal(result.visual.status, "unverified");
    assert.equal(result.visual.reason, "identical-light-dark-pngs");
    assert.equal(result.visual.passed, false);
  });
});
