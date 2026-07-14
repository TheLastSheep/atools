import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  normalizeStableReleaseTag,
  RELEASE_REPOSITORY,
} from "./version-contract.mjs";

export const REQUIRED_MACOS_PLATFORMS = ["darwin-aarch64", "darwin-x86_64"];
export const UPDATER_RELEASE_VERIFIED_PREFIX = "ATOOLS_UPDATER_RELEASE_VERIFIED ";

export function validateUpdaterManifest({
  manifest,
  version,
  tag,
  assets,
  repository = RELEASE_REPOSITORY,
}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Updater manifest must be a JSON object");
  }
  const expectedVersion = String(version ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    throw new Error(`Expected version must be stable SemVer: ${JSON.stringify(expectedVersion)}`);
  }
  const tagVersion = normalizeStableReleaseTag(tag);
  if (tagVersion !== expectedVersion) {
    throw new Error(`Release tag version ${tagVersion} must match requested version ${expectedVersion}`);
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(`Updater manifest version ${JSON.stringify(manifest.version)} must match ${expectedVersion}`);
  }
  if (typeof manifest.pub_date !== "string" || Number.isNaN(Date.parse(manifest.pub_date))) {
    throw new Error("Updater manifest pub_date must be a valid timestamp");
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object" || Array.isArray(manifest.platforms)) {
    throw new Error("Updater manifest platforms must be an object");
  }

  const assetNames = new Set(Array.isArray(assets) ? assets.map(String) : []);
  const urls = new Set();
  const platforms = {};
  const expectedPathPrefix = `/${repository}/releases/download/${tag}/`;

  for (const platform of REQUIRED_MACOS_PLATFORMS) {
    const entry = manifest.platforms[platform];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Updater manifest is missing required platform ${platform}`);
    }
    if (typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw new Error(`Updater signature for ${platform} must be non-empty`);
    }
    if (typeof entry.url !== "string" || !entry.url.trim()) {
      throw new Error(`Updater URL for ${platform} must be non-empty`);
    }

    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`Updater URL for ${platform} is invalid`);
    }
    if (url.protocol !== "https:") {
      throw new Error(`Updater URL for ${platform} must use HTTPS`);
    }
    if (url.hostname !== "github.com" || !url.pathname.startsWith(expectedPathPrefix)) {
      throw new Error(
        `Updater URL for ${platform} must reference repository ${repository} and tag ${tag}`,
      );
    }
    if (url.search || url.hash) {
      throw new Error(`Updater URL for ${platform} must not contain a query or fragment`);
    }
    if (urls.has(url.href)) {
      throw new Error(`Updater manifest contains duplicate URL ${url.href}`);
    }
    urls.add(url.href);

    const encodedAssetName = url.pathname.slice(expectedPathPrefix.length);
    const assetName = decodeAssetName(encodedAssetName, platform);
    if (!assetName || assetName.includes("/")) {
      throw new Error(`Updater URL for ${platform} must reference one release asset basename`);
    }
    if (!assetNames.has(assetName)) {
      throw new Error(`Updater asset ${assetName} for ${platform} is not present in Release assets`);
    }
    platforms[platform] = {
      asset: assetName,
      url: url.href,
      signature: entry.signature.trim(),
    };
  }

  return { version: expectedVersion, tag, repository, platforms };
}

export function parseVerifierArguments(argv) {
  const options = { assets: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--manifest", "--version", "--tag", "--asset"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    index += 1;
    if (name === "--asset") options.assets.push(value);
    else options[name.slice(2)] = value;
  }
  for (const required of ["manifest", "version", "tag"]) {
    if (!options[required]) throw new Error(`Missing required --${required}`);
  }
  return options;
}

function decodeAssetName(value, platform) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Updater asset URL for ${platform} contains invalid encoding`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseVerifierArguments(process.argv.slice(2));
    const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
    const result = validateUpdaterManifest({
      manifest,
      version: options.version,
      tag: options.tag,
      assets: options.assets,
    });
    console.log(`${UPDATER_RELEASE_VERIFIED_PREFIX}${JSON.stringify(result)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
