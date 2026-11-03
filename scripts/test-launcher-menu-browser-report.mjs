import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { writeLauncherBrowserReport } from "./lib/launcher-menu-browser-report.mjs";

const driver = resolve(import.meta.dirname, "probe-launcher-menu-dismissal-browser.mjs");
const source = await readFile(driver, "utf8");
const main = source.slice(source.indexOf("async function main() {"), source.lastIndexOf("await main();"));
assert.ok(main.startsWith("async function main() {"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function executeMain({ browserError, failPrimary = true, partialWrite = false } = {}, check) {
  const directory = await mkdtemp(join(tmpdir(), "atools-menu-report-main-test-"));
  const outputPath = join(directory, "output.json");
  const logs = [];
  const processDouble = { argv: ["node", driver, outputPath], exitCode: undefined };
  let openAttempts = 0;
  const openImpl = async (path, ...args) => {
    openAttempts += 1;
    if (path === outputPath && failPrimary) {
      const error = Object.assign(new Error("injected primary output persistence failure"), { code: "EIO" });
      if (!partialWrite) throw error;
      const handle = await open(path, ...args);
      return {
        async writeFile() { await handle.writeFile("retained partial primary output"); throw error; },
        async close() { await handle.close(); },
      };
    }
    return open(path, ...args);
  };
  const run = new AsyncFunction("dirname", "parseArgs", "mkdir", "hashSources", "readFile", "resolve", "tmpdir",
    "randomUUID", "runBrowser", "rm", "open", "process", "console", "assert", "writeLauncherBrowserReport",
    `const port=15132;\n${main}\nawait main();`);
  try {
    await run(dirname, () => ({ outputPath, validateOnly: false }), mkdir,
      async () => ({ sha256: "stable-test-selection", files: [] }), readFile, resolve, () => directory, randomUUID,
      async report => {
        report.status = "passed";
        report.checks = ["successful browser double; no browser started"];
        report.cleanup = { allOwnedResourcesClean: true, errors: [], scratch: { state: "created" } };
        if (browserError) { report.error = { name: "Error", message: browserError, stack: "test browser failure" }; throw new Error(browserError); }
      }, rm, openImpl, processDouble,
      { log: value => logs.push(JSON.parse(value)), error: value => logs.push(JSON.parse(value)) }, assert,
      (report, path) => writeLauncherBrowserReport(report, path, { openImpl, randomUUIDImpl: () => "fixed-test-fallback" }));
    await check({ outputPath, logs, processDouble, openAttempts, directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("exact main returns nonzero when primary persistence fails but fallback succeeds", async () => {
  await executeMain({}, async ({ outputPath, logs, processDouble, openAttempts }) => {
    assert.equal(processDouble.exitCode, 1);
    assert.equal(openAttempts, 2);
    const fallbackPath = `${outputPath}.failed-fixed-test-fallback.json`;
    const report = JSON.parse(await readFile(fallbackPath, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.outputPath, outputPath);
    assert.equal(report.outputFallbackPath, fallbackPath);
    assert.equal(report.error.message, "injected primary output persistence failure");
    assert.equal(report.outputWriteErrors[0].error.code, "EIO");
    assert.equal(report.outputWriteErrors[0].path, outputPath);
    assert.equal(logs.at(-1).outputPath, fallbackPath);
    await assert.rejects(access(outputPath), error => error.code === "ENOENT");
  });
});

test("fallback preserves both an existing browser failure and the primary write failure", async () => {
  await executeMain({ browserError: "earlier browser assertion failure" }, async ({ outputPath, processDouble }) => {
    assert.equal(processDouble.exitCode, 1);
    const report = JSON.parse(await readFile(`${outputPath}.failed-fixed-test-fallback.json`, "utf8"));
    assert.equal(report.error.message, "earlier browser assertion failure");
    assert.equal(report.outputWriteErrors[0].error.message, "injected primary output persistence failure");
  });
});

test("fallback does not overwrite a partially written primary report", async () => {
  await executeMain({ partialWrite: true }, async ({ outputPath, processDouble }) => {
    assert.equal(processDouble.exitCode, 1);
    assert.equal(await readFile(outputPath, "utf8"), "retained partial primary output");
    const report = JSON.parse(await readFile(`${outputPath}.failed-fixed-test-fallback.json`, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.outputWriteErrors[0].error.message, "injected primary output persistence failure");
  });
});

test("exact main succeeds only when the passed report is persisted at its requested path", async () => {
  await executeMain({ failPrimary: false }, async ({ outputPath, processDouble, openAttempts, directory }) => {
    assert.equal(processDouble.exitCode ?? 0, 0);
    assert.equal(openAttempts, 1);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.status, "passed");
    assert.equal(report.outputFallbackPath, undefined);
    await assert.rejects(access(join(directory, `output.json.failed-fixed-test-fallback.json`)), error => error.code === "ENOENT");
  });
});

test("existing primary and fallback files are never overwritten and both failures are retained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-menu-report-collision-test-"));
  const primary = join(directory, "output.json"), fallback = `${primary}.failed-fixed-test-fallback.json`;
  try {
    await writeFile(primary, "original primary", { flag: "wx" });
    await writeFile(fallback, "original fallback", { flag: "wx" });
    const report = { status: "passed" };
    await assert.rejects(writeLauncherBrowserReport(report, primary, { randomUUIDImpl: () => "fixed-test-fallback" }), AggregateError);
    assert.equal(report.status, "failed");
    assert.equal(report.outputFallbackPath, fallback);
    assert.deepEqual(report.outputWriteErrors.map(item => item.error.code), ["EEXIST", "EEXIST"]);
    assert.equal(await readFile(primary, "utf8"), "original primary");
    assert.equal(await readFile(fallback, "utf8"), "original fallback");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a close failure cannot erase the preceding output write failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-menu-report-close-test-"));
  const primary = join(directory, "output.json");
  try {
    const report = { status: "passed" };
    await writeLauncherBrowserReport(report, primary, { randomUUIDImpl: () => "fixed-test-fallback",
      openImpl: async (path, ...args) => path === primary ? {
        async writeFile() { throw Object.assign(new Error("original write failure"), { code: "EIO" }); },
        async close() { throw Object.assign(new Error("subsequent close failure"), { code: "EPIPE" }); },
      } : open(path, ...args) });
    const persisted = JSON.parse(await readFile(`${primary}.failed-fixed-test-fallback.json`, "utf8"));
    assert.deepEqual(persisted.outputWriteErrors[0].error.errors.map(item => item.message), ["original write failure", "subsequent close failure"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

console.log(JSON.stringify({ scope: "Exact driver main with explicit browser and source-selection doubles, real temporary file writes, and injected primary output errors; no browser/GUI/network acceptance",
  driverSha256: createHash("sha256").update(source).digest("hex") }));
