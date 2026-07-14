import { readFile } from "node:fs/promises";

export const RELEASE_REPOSITORY = "TheLastSheep/atools";
export const RELEASE_MANIFEST_ENDPOINT =
  `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`;
export const WORKSPACE_CRATES = [
  "atools",
  "atools-api-shim",
  "atools-core",
  "atools-plugin",
];

export function evaluateVersionContract(input) {
  const releaseVersion = String(input.packageJson?.version ?? "").trim();
  const errors = [];
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    errors.push("package version must be stable SemVer (major.minor.patch)");
  }

  compareVersion(errors, "Tauri bundle", input.tauriConfig?.version, releaseVersion);
  compareVersion(
    errors,
    "Rust workspace",
    input.workspaceCargo?.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1],
    releaseVersion,
  );

  for (const crate of WORKSPACE_CRATES) {
    const escapedName = crate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lockedVersion = input.cargoLock?.match(
      new RegExp(`\\[\\[package\\]\\]\\nname = "${escapedName}"\\nversion = "([^"]+)"`),
    )?.[1];
    compareVersion(errors, `Cargo.lock ${crate}`, lockedVersion, releaseVersion);
  }

  if (input.expectedVersion !== undefined) {
    compareVersion(errors, "requested release", input.expectedVersion, releaseVersion);
  }

  return { version: releaseVersion, errors };
}

export function assertVersionContract(input) {
  const result = evaluateVersionContract(input);
  if (result.errors.length > 0) {
    throw new Error(`Version contract failed:\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}

export async function readVersionContract(root, options = {}) {
  const [packageJsonText, tauriConfigText, workspaceCargo, cargoLock] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
    readFile(new URL("Cargo.toml", root), "utf8"),
    readFile(new URL("Cargo.lock", root), "utf8"),
  ]);
  return {
    packageJson: JSON.parse(packageJsonText),
    tauriConfig: JSON.parse(tauriConfigText),
    workspaceCargo,
    cargoLock,
    expectedVersion: options.expectedVersion,
  };
}

export function normalizeStableReleaseTag(tag) {
  const value = String(tag ?? "").trim();
  const match = /^v(\d+\.\d+\.\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Release tag must be stable vX.Y.Z SemVer: ${JSON.stringify(value)}`);
  }
  return match[1];
}

export async function assertRepositoryVersions(root, expectedVersion) {
  return assertVersionContract(await readVersionContract(root, { expectedVersion }));
}

function compareVersion(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label} version ${JSON.stringify(actual ?? null)} must match ${JSON.stringify(expected)}`);
  }
}
