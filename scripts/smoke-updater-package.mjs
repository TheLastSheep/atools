import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UPDATER_PACKAGE_SMOKE_PREFIX = "ATOOLS_UPDATER_PACKAGE_SMOKE ";

export function parseUpdaterPackageSmokeOutput(output) {
  const line = String(output)
    .split(/\r?\n/)
    .find((item) => item.startsWith(UPDATER_PACKAGE_SMOKE_PREFIX));
  if (!line) throw new Error("Missing ATOOLS_UPDATER_PACKAGE_SMOKE output");
  return JSON.parse(line.slice(UPDATER_PACKAGE_SMOKE_PREFIX.length));
}

export async function runUpdaterPackageSmoke(options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("Packaged updater smoke is supported only on macOS");
  }
  const repositoryRoot = options.repositoryRoot ?? fileURLToPath(new URL("../", import.meta.url));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atools-updater-smoke-")));
  const password = "atools-disposable-updater-smoke";
  const keyPath = join(root, "updater-smoke.key");
  const serverRoot = join(root, "server");
  const children = new Set();
  let server;

  try {
    mkdirSync(serverRoot, { recursive: true });
    const tauriCli = join(repositoryRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
    runNode(tauriCli, [
      "signer", "generate", "--ci", "--password", password, "--write-keys", keyPath,
    ], { cwd: repositoryRoot, stdio: "ignore" });
    const privateKey = readFileSync(keyPath, "utf8");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const signingEnv = {
      TAURI_SIGNING_PRIVATE_KEY: privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    };

    const buildTarget = join(repositoryRoot, "target", "updater-smoke");
    buildBundle({
      repositoryRoot,
      tauriCli,
      root,
      targetDir: buildTarget,
      version: "3.0.0",
      publicKey,
      signingEnv,
    });
    const updaterArchive = findExactlyOne(buildTarget, (path) => path.endsWith(".app.tar.gz"));
    const updaterSignaturePath = `${updaterArchive}.sig`;
    if (!existsSync(updaterSignaturePath)) {
      throw new Error(`Updater signature is missing: ${updaterSignaturePath}`);
    }
    const servedArchive = join(serverRoot, "ATools.3.0.0.app.tar.gz");
    cpSync(updaterArchive, servedArchive);
    const validSignature = readFileSync(updaterSignaturePath, "utf8").trim();

    buildBundle({
      repositoryRoot,
      tauriCli,
      root,
      targetDir: buildTarget,
      version: "2.99.99",
      publicKey,
      signingEnv,
    });
    const baselineApp = findExactlyOne(
      buildTarget,
      (path) => path.endsWith("ATools 3.0.app") && statSync(path).isDirectory(),
      { includeDirectories: true },
    );

    const fixture = { manifests: new Map(), archive: servedArchive };
    server = createFixtureServer(fixture);
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const platform = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
    const otherPlatform = platform === "darwin-aarch64" ? "darwin-x86_64" : "darwin-aarch64";
    const updateUrl = `${baseUrl}/asset/ATools.3.0.0.app.tar.gz`;
    const entry = { signature: validSignature, url: updateUrl };
    fixture.manifests.set("no-update", releaseManifest("2.99.99", { [platform]: entry }));
    fixture.manifests.set("missing-architecture", releaseManifest("3.0.0", { [otherPlatform]: entry }));
    fixture.manifests.set("invalid-signature", releaseManifest("3.0.0", {
      [platform]: { ...entry, signature: corruptSignature(validSignature) },
    }));
    fixture.manifests.set("valid-update-relaunch", releaseManifest("3.0.0", { [platform]: entry }));

    const scenarioExpectations = [
      ["no-update", "no-update"],
      ["missing-architecture", "missing-architecture"],
      ["invalid-signature", "invalid-signature"],
      ["valid-update-relaunch", "valid-update-relaunch"],
    ];
    const checks = [];
    for (const [scenario, expectedOutcome] of scenarioExpectations) {
      const scenarioRoot = join(root, scenario);
      const appPath = join(scenarioRoot, "ATools 3.0.app");
      const homePath = join(scenarioRoot, "home");
      const reportPath = join(scenarioRoot, "report.json");
      mkdirSync(homePath, { recursive: true });
      cpSync(baselineApp, appPath, { recursive: true });
      const executable = findExactlyOne(join(appPath, "Contents", "MacOS"), () => true);
      const child = spawn(executable, [], {
        cwd: scenarioRoot,
        env: {
          ...process.env,
          HOME: homePath,
          ATOOLS_UPDATER_SMOKE: "1",
          ATOOLS_UPDATER_SMOKE_ENDPOINT: `${baseUrl}/${scenario}/latest.json`,
          ATOOLS_UPDATER_SMOKE_SCENARIO: scenario,
          ATOOLS_UPDATER_SMOKE_REPORT: reportPath,
        },
        stdio: "ignore",
      });
      children.add(child);
      try {
        const scenarioReport = await waitForScenarioReport(reportPath, expectedOutcome, 120_000);
        if (scenarioReport.status !== "ok") {
          throw new Error(`${scenario} failed: ${scenarioReport.message ?? "unknown error"}`);
        }
        if (scenario === "valid-update-relaunch") {
          const infoPlist = join(appPath, "Contents", "Info.plist");
          const installedVersion = execFileSync(
            "/usr/bin/plutil",
            ["-extract", "CFBundleShortVersionString", "raw", infoPlist],
            { encoding: "utf8" },
          ).trim();
          if (installedVersion !== "3.0.0" || scenarioReport.currentVersion !== "3.0.0") {
            throw new Error(`valid update did not install and relaunch 3.0.0: ${installedVersion}`);
          }
        } else {
          const infoPlist = join(appPath, "Contents", "Info.plist");
          const unchangedVersion = execFileSync(
            "/usr/bin/plutil",
            ["-extract", "CFBundleShortVersionString", "raw", infoPlist],
            { encoding: "utf8" },
          ).trim();
          if (unchangedVersion !== "2.99.99") {
            throw new Error(`${scenario} unexpectedly changed the installed version`);
          }
        }
        checks.push({ id: scenario, status: "ok" });
      } finally {
        children.delete(child);
        if (child.exitCode === null) child.kill("SIGTERM");
        killScopedExecutables(scenarioRoot);
      }
    }

    return { status: "ok", checks };
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    if (server) await closeServer(server);
    killScopedExecutables(root);
    rmSync(root, { recursive: true, force: true });
  }
}

function buildBundle({ repositoryRoot, tauriCli, root, targetDir, version, publicKey, signingEnv }) {
  const overlayPath = join(root, `tauri-smoke-${version}.json`);
  writeFileSync(overlayPath, JSON.stringify({
    version,
    build: {
      beforeBuildCommand: `${process.execPath} ${join(repositoryRoot, "node_modules", "vite", "bin", "vite.js")} build`,
    },
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: publicKey,
        endpoints: ["https://127.0.0.1.invalid/latest.json"],
      },
    },
  }));
  runNode(tauriCli, [
    "build",
    "--debug",
    "--bundles", "app",
    "--config", overlayPath,
    "--ci",
    "--ignore-version-mismatches",
  ], {
    cwd: repositoryRoot,
    env: { ...signingEnv, CARGO_TARGET_DIR: targetDir },
    stdio: "inherit",
  });
}

function runNode(script, args, options) {
  execFileSync(process.execPath, [script, ...args], {
    ...options,
    env: { ...process.env, ...options.env },
  });
}

function releaseManifest(version, platforms) {
  return {
    version,
    notes: "Disposable ATools updater smoke",
    pub_date: "2026-07-14T00:00:00Z",
    platforms,
  };
}

function corruptSignature(signature) {
  const index = Math.max(0, Math.floor(signature.length / 2));
  const replacement = signature[index] === "A" ? "B" : "A";
  return `${signature.slice(0, index)}${replacement}${signature.slice(index + 1)}`;
}

function createFixtureServer(fixture) {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/asset/ATools.3.0.0.app.tar.gz") {
      const archive = readFileSync(fixture.archive);
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(archive.length),
      });
      response.end(archive);
      return;
    }
    const match = /^\/([^/]+)\/latest\.json$/.exec(url.pathname);
    const manifest = match ? fixture.manifests.get(match[1]) : null;
    if (!manifest) {
      response.writeHead(404).end("not found");
      return;
    }
    const body = Buffer.from(JSON.stringify(manifest));
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(body.length),
    });
    response.end(body);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForScenarioReport(path, expectedOutcome, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const report = JSON.parse(readFileSync(path, "utf8"));
        if (report.outcome === expectedOutcome) return report;
      } catch {
        // The app may be replacing the report atomically; retry until the deadline.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for updater smoke outcome ${expectedOutcome}`);
}

function findExactlyOne(root, predicate, options = {}) {
  const matches = [];
  walk(root, (path, stats) => {
    if ((stats.isFile() || options.includeDirectories && stats.isDirectory()) && predicate(path)) {
      matches.push(path);
    }
  });
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one matching path under ${root}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return matches[0];
}

function walk(root, visitor) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stats = statSync(path);
    visitor(path, stats);
    if (entry.isDirectory()) walk(path, visitor);
  }
}

function killScopedExecutables(scope) {
  if (!scope) return;
  try {
    execFileSync("/usr/bin/pkill", ["-f", scope], { stdio: "ignore" });
  } catch {
    // No matching disposable process remains.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runUpdaterPackageSmoke();
    console.log(`${UPDATER_PACKAGE_SMOKE_PREFIX}${JSON.stringify(report)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
