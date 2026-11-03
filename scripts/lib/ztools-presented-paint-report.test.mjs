import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  PRESENTED_PAINT_FILENAMES,
  PRESENTED_PAINT_SCOPE,
  validatePresentedPaintReport,
} from "./ztools-presented-paint-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const readiness = {
  routeGeneral: true,
  mediaMatches: true,
  menusAbsent: true,
  rootTextMatches: true,
  sidebarTextMatches: true,
  labelTextMatches: true,
  framesObserved: true,
  settled: true,
};
const visiblePresentation = {
  visible: true,
  windowFocused: false,
  windowKey: false,
  appActive: false,
  frontmostIsSelf: false,
};
const windowTrace = {
  schemaVersion: 1,
  baseline: {
    visible: false, occlusionVisible: false, onActiveSpace: false, windowFocused: false,
    windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
  },
  afterOrderFront: {
    visible: true, occlusionVisible: false, onActiveSpace: false, windowFocused: false,
    windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
  },
  lastVisibility: {
    visible: true, occlusionVisible: true, onActiveSpace: true, windowFocused: false,
    windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
  },
  afterHide: {
    visible: false, occlusionVisible: false, onActiveSpace: false, windowFocused: false,
    windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
  },
  visibilitySamples: 5,
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}

function png(colorOffset = 0) {
  const width = 16;
  const height = 16;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = (x + colorOffset) % 255;
      pixels[offset + 1] = y % 255;
      pixels[offset + 2] = 127;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function evidence(bytes) {
  return {
    width: 16,
    height: 16,
    pngBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    nonUniform: true,
    nonTransparent: true,
  };
}

function captured(theme, bytes) {
  return {
    state: "captured",
    filename: PRESENTED_PAINT_FILENAMES[theme],
    evidence: evidence(bytes),
    reason: null,
  };
}

function step(theme, bytes, appearance = theme) {
  const dark = appearance === "dark";
  return {
    theme,
    themeControlFound: true,
    themeMenuOpened: true,
    optionSetValid: true,
    selectionDispatched: true,
    selected: true,
    selectedTheme: theme,
    databaseTheme: theme,
    childMediaDark: dark,
    mainMediaDark: dark,
    nativeAppearance: appearance,
    readiness: theme === "system" ? null : structuredClone(readiness),
    presentation: structuredClone(visiblePresentation),
    snapshot: theme === "system"
      ? { state: "not-required", filename: null, evidence: null, reason: null }
      : captured(theme, bytes),
  };
}

function validReport(lightBytes, darkBytes) {
  return {
    schemaVersion: 2,
    journey: "settings-input-presented-paint",
    scope: PRESENTED_PAINT_SCOPE,
    mode: "visible-unfocused",
    attempted: true,
    identifier: owner.identifier,
    root: owner.root,
    pid: owner.pid,
    runId,
    elapsedMs: 12_000,
    passed: true,
    presentation: structuredClone(visiblePresentation),
    steps: [step("light", lightBytes), step("dark", darkBytes), step("system", darkBytes, "dark")],
    restoration: {
      selectedTheme: "dark",
      databaseTheme: "dark",
      childMediaDark: true,
      mainMediaDark: true,
      nativeAppearance: "dark",
      presentation: structuredClone(visiblePresentation),
    },
    cleanup: {
      hideConfirmed: true,
      visible: false,
      windowFocused: false,
      windowKey: false,
      appActive: false,
      frontmostIsSelf: false,
    },
    windowTrace: structuredClone(windowTrace),
    errors: [],
  };
}

async function withDirectory(callback, { light = png(0), dark = png(31) } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atools-presented-paint-")));
  try {
    await writeFile(join(directory, PRESENTED_PAINT_FILENAMES.light), light, { flag: "wx" });
    await writeFile(join(directory, PRESENTED_PAINT_FILENAMES.dark), dark, { flag: "wx" });
    await callback(directory, light, dark);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts the frozen visible-unfocused facts and validates both actual PNGs", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.equal(result.summary.mode, "visible-unfocused");
    assert.equal(result.summary.steps.system.readiness, null);
    assert.equal(result.summary.steps.system.snapshot.state, "not-required");
    assert.equal(result.summary.steps.light.snapshot.evidence.sha256, evidence(light).sha256);
  });
});

test("rejects missing and extra schema keys, owner mismatch, reordering, and a trusted pass bit", async () => {
  await withDirectory(async (directory, light, dark) => {
    for (const mutate of [
      report => { delete report.presentation; },
      report => { report.unexpected = true; },
      report => { report.windowTrace.unexpected = true; },
      report => { report.pid += 1; },
      report => { report.steps.reverse(); },
      report => { report.steps[0].selectedTheme = "dark"; },
      report => { report.steps[1].nativeAppearance = "light"; },
      report => { report.passed = false; },
    ]) {
      const report = validReport(light, dark);
      mutate(report);
      const result = await validatePresentedPaintReport(report, owner, directory);
      assert.equal(result.valid, false);
      assert.equal(result.passed, false);
    }
  });
});

test("accepts partial unknown trace facts while requiring explicit safety facts to pass", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.windowTrace.baseline.occlusionVisible = null;
    report.windowTrace.baseline.appHidden = null;
    report.windowTrace.afterOrderFront.occlusionVisible = null;
    report.windowTrace.afterOrderFront.onActiveSpace = false;
    report.windowTrace.afterHide.occlusionVisible = null;
    report.windowTrace.afterHide.appHidden = null;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, true);
    assert.equal(result.summary.windowTrace.afterOrderFront.occlusionVisible, null);

    const missingSafetyFact = validReport(light, dark);
    missingSafetyFact.windowTrace.lastVisibility.frontmostIsSelf = null;
    missingSafetyFact.passed = false;
    const failed = await validatePresentedPaintReport(missingSafetyFact, owner, directory);
    assert.equal(failed.valid, true, JSON.stringify(failed));
    assert.equal(failed.passed, false);
    assert.equal(failed.summary.windowTrace.lastVisibility.frontmostIsSelf, null);

    const unknownOrderFrontSafety = validReport(light, dark);
    unknownOrderFrontSafety.windowTrace.afterOrderFront.appActive = null;
    unknownOrderFrontSafety.passed = false;
    const unknown = await validatePresentedPaintReport(unknownOrderFrontSafety, owner, directory);
    assert.equal(unknown.valid, true, JSON.stringify(unknown));
    assert.equal(unknown.passed, false);
    assert.equal(unknown.summary.windowTrace.afterOrderFront.appActive, null);
  });
});

test("accepts an unobserved trace structure only as a failed paint run", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.windowTrace = {
      schemaVersion: 1,
      baseline: null,
      afterOrderFront: null,
      lastVisibility: null,
      afterHide: null,
      visibilitySamples: 0,
    };
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, false);
    assert.deepEqual(result.summary.windowTrace, report.windowTrace);
  });
});

test("rejects contradictory observed afterHide and cleanup facts", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.cleanup.visible = true;
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
    assert.ok(result.errors.includes("presented-paint-window-trace-cleanup-mismatch"));
  });
});

test("a focus or activation fact can be recorded as a valid failed phase but never as a pass", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.presentation.frontmostIsSelf = true;
    report.errors = ["settings-input-presented-paint-focus-changed"];
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, false);
    assert.equal(result.summary.presentation.frontmostIsSelf, true);
  });
});

test("missing native appearance readbacks remain valid observations but cannot pass", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.steps[0].childMediaDark = null;
    report.steps[0].mainMediaDark = null;
    report.steps[0].nativeAppearance = null;
    report.steps[0].snapshot = {
      state: "unverified", filename: null, evidence: null,
      reason: "settings-input-presented-paint-theme-convergence-timeout",
    };
    report.errors = ["settings-input-presented-paint-theme-convergence-timeout"];
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, false);
    assert.equal(result.summary.steps.light.nativeAppearance, null);
  });
});

test("accepts explicit unverified paint facts only as a failed phase", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.steps[0].readiness.sidebarTextMatches = false;
    report.steps[0].snapshot = {
      state: "unverified", filename: null, evidence: null,
      reason: "settings-input-presented-paint-readiness-timeout",
    };
    report.errors = ["settings-input-presented-paint-readiness-timeout"];
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.passed, false);
    assert.equal(result.summary.steps.light.snapshot.state, "unverified");
  });
});

test("requires all readiness facts before a captured PNG", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.steps[0].readiness.menusAbsent = false;
    report.passed = false;
    report.errors = ["settings-input-presented-paint-readiness-timeout"];
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  });
});

test("rejects unknown Native error codes and malformed fixed observations", async () => {
  await withDirectory(async (directory, light, dark) => {
    const errorReport = validReport(light, dark);
    errorReport.errors = ["/private/tmp/raw-path-or-exception"];
    errorReport.passed = false;
    assert.equal((await validatePresentedPaintReport(errorReport, owner, directory)).valid, false);

    const shapeReport = validReport(light, dark);
    shapeReport.steps[2].readiness = { settled: true };
    shapeReport.steps[0].presentation.windowKey = "window name";
    shapeReport.passed = false;
    const result = await validatePresentedPaintReport(shapeReport, owner, directory);
    assert.equal(result.valid, false);
    assert.equal(JSON.stringify(result).includes("window name"), false);
    assert.equal(JSON.stringify(result).includes("raw-path-or-exception"), false);
  });
});

test("rejects actual PNG CRC, hash, dimensions, size, and filesystem mismatches", async () => {
  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    const brokenCrc = Buffer.from(dark);
    brokenCrc[29] ^= 0xff;
    await writeFile(join(directory, PRESENTED_PAINT_FILENAMES.dark), brokenCrc);
    assert.equal((await validatePresentedPaintReport(report, owner, directory)).valid, false);
  });

  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.steps[0].snapshot.evidence.sha256 = "0".repeat(64);
    assert.equal((await validatePresentedPaintReport(report, owner, directory)).valid, false);

    report.steps[0].snapshot.evidence.width = 4096;
    report.steps[0].snapshot.evidence.height = 4096;
    assert.equal((await validatePresentedPaintReport(report, owner, directory)).valid, false);

    await rm(join(directory, PRESENTED_PAINT_FILENAMES.light));
    await symlink(join(directory, PRESENTED_PAINT_FILENAMES.dark), join(directory, PRESENTED_PAINT_FILENAMES.light));
    assert.equal((await validatePresentedPaintReport(validReport(light, dark), owner, directory)).valid, false);
  });

  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.steps[0].snapshot.evidence.width = 4096;
    report.steps[0].snapshot.evidence.height = 4096;
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("presented-paint-light-snapshot-evidence-shape"));
  });

  await withDirectory(async (directory, light, dark) => {
    const report = validReport(light, dark);
    report.steps[0].snapshot.evidence.pngBytes = 8 * 1024 * 1024 + 1;
    report.passed = false;
    const result = await validatePresentedPaintReport(report, owner, directory);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("presented-paint-light-snapshot-evidence-shape"));
  });
});
