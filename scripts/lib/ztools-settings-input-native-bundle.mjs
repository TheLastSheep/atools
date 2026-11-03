import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { cleanupOwnedRendererApp } from "./ztools-renderer-native-runtime.mjs";
import { stageSettingsNativeBundle } from "./ztools-settings-native-sources.mjs";
import { stageTimestampBuiltinControl } from "./ztools-settings-input-builtin-control.mjs";
import { stageFallbackSettingsNativeResources } from "./fallback-settings-native-sources.mjs";

function fail(message) {
  throw new Error(message);
}

function validRunId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function settingsInputBundleIdentifier(runId) {
  if (!validRunId(runId)) fail("Settings-input bundle identity requires a lowercase run UUID");
  return `dev.atools.renderer-settings-input.${runId}`;
}

export function settingsInputInfoPlist(runId) {
  const identifier = settingsInputBundleIdentifier(runId);
  const displayName = `ATools Settings Input ${runId.slice(0, 8)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AToolsRendererSmoke</string>
<key>CFBundleIdentifier</key><string>${escapeXml(identifier)}</string>
<key>CFBundleName</key><string>${escapeXml(displayName)}</string>
<key>CFBundleDisplayName</key><string>${escapeXml(displayName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSUIElement</key><false/>
</dict></plist>
`;
}

function identity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory() || Number(info.mode & 0o777n) !== 0o700
      || await realpath(path) !== path) fail("Settings-input app directory is not private and canonical");
  return info;
}

async function regularFile(path, mode) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n
      || (mode !== null && Number(info.mode & 0o777n) !== mode)) {
    fail("Settings-input app file has an invalid type or mode");
  }
  return info;
}

async function ensureAbsent(path) {
  try {
    await lstat(path);
    fail("Settings-input app bundle path must be fresh");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** Stages the exact hidden settings-input app identity plus the pinned child app resources. */
export async function stageSettingsInputNativeBundle({
  binaryFingerprint, runDirectory, runId, settingsSourceSnapshot, nativeSourceHashes, fallbackSourceSnapshot = null,
}) {
  if (!binaryFingerprint || !isAbsolute(binaryFingerprint.path)
      || !/^[0-9a-f]{64}$/.test(binaryFingerprint.sha256 ?? "")
      || !isAbsolute(runDirectory) || normalize(runDirectory) !== runDirectory
      || !settingsSourceSnapshot || !nativeSourceHashes || !validRunId(runId)) {
    fail("Invalid settings-input app staging inputs");
  }
  const canonicalRunDirectory = await realpath(runDirectory);
  if (canonicalRunDirectory !== runDirectory) fail("Settings-input run directory must be canonical");
  await privateDirectory(canonicalRunDirectory);
  const sourcePath = await realpath(binaryFingerprint.path);
  if (sourcePath !== binaryFingerprint.path) fail("Settings-input source executable must be canonical");
  const sourceInfo = await regularFile(sourcePath, null);
  if (await hashFile(sourcePath) !== binaryFingerprint.sha256) fail("Settings-input source executable fingerprint changed");

  const identifier = settingsInputBundleIdentifier(runId);
  const displayName = `ATools Settings Input ${runId.slice(0, 8)}`;
  const bundlePath = join(canonicalRunDirectory, "case-never.app");
  if (dirname(bundlePath) !== canonicalRunDirectory) fail("Settings-input app bundle must be a direct run child");
  await ensureAbsent(bundlePath);
  const bundleInfo = await privateDirectory(bundlePath, true);
  const contentsPath = join(bundlePath, "Contents");
  const executableDirectory = join(contentsPath, "MacOS");
  const resourcesDirectory = join(contentsPath, "Resources");
  const executablePath = join(executableDirectory, "AToolsRendererSmoke");
  const infoPlistPath = join(contentsPath, "Info.plist");
  let complete = false;
  try {
    await privateDirectory(contentsPath, true);
    await privateDirectory(executableDirectory, true);
    await privateDirectory(resourcesDirectory, true);
    await copyFile(sourcePath, executablePath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(executablePath, 0o700);
    const executableInfo = await regularFile(executablePath, 0o700);
    const stagedSha256 = await hashFile(executablePath);
    if (stagedSha256 !== binaryFingerprint.sha256 || executableInfo.size !== sourceInfo.size) {
      fail("Settings-input staged executable differs from its source fingerprint");
    }

    const builtinControl = await stageTimestampBuiltinControl({
      appResourcesPath: resourcesDirectory,
      sourceHashes: nativeSourceHashes,
    });
    const settingsBundle = await stageSettingsNativeBundle({
      snapshot: settingsSourceSnapshot,
      appBundlePath: bundlePath,
    });
    if (settingsBundle.resourcePath !== "Contents/Resources/ztools-settings"
        || !Number.isSafeInteger(settingsBundle.resourceCount) || settingsBundle.resourceCount <= 0
        || !Number.isSafeInteger(settingsBundle.resourceBytes) || settingsBundle.resourceBytes <= 0
        || !/^[0-9a-f]{64}$/.test(settingsBundle.distSha256 ?? "")
        || !/^[0-9a-f]{64}$/.test(settingsBundle.provenanceSha256 ?? "")) {
      fail("Settings-input child resources were not fully staged");
    }
    const fallbackSettingsBundle = fallbackSourceSnapshot
      ? await stageFallbackSettingsNativeResources(fallbackSourceSnapshot, bundlePath)
      : null;
    if (fallbackSourceSnapshot && fallbackSettingsBundle?.staged !== true) {
      fail("Fallback Settings QA resources were not fully staged");
    }

    const infoPlist = settingsInputInfoPlist(runId);
    if (!infoPlist.includes(`<key>CFBundleIdentifier</key><string>${identifier}</string>`)) {
      fail("Settings-input bundle identifier does not match its profile");
    }
    await writeFile(infoPlistPath, infoPlist, { flag: "wx", mode: 0o600 });
    await regularFile(infoPlistPath, 0o600);
    await privateDirectory(bundlePath);
    complete = true;
    return {
      bundlePath,
      runDirectory: canonicalRunDirectory,
      executable: executablePath,
      identifier,
      infoPlistIdentifier: identifier,
      displayName,
      runId,
      sourceSha256: binaryFingerprint.sha256,
      stagedSha256,
      builtinControl,
      settingsBundle: { staged: true, ...settingsBundle },
      fallbackSettingsBundle,
      infoPlist,
      ownerIdentity: identity(bundleInfo),
    };
  } finally {
    if (!complete) {
      await cleanupOwnedRendererApp({
        bundlePath, runDirectory: canonicalRunDirectory,
        ownerIdentity: identity(bundleInfo), processTerminal: true,
      });
    }
  }
}
