import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

/** Give the reviewed fixture a unique OS identity; never register or replace the installed app. */
export async function stageNativeSmokeApp(executable, scratch, runId = randomUUID()) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId)
    || !isAbsolute(executable) || !isAbsolute(scratch)) throw Error("Absolute fixture inputs and a UUID are required");
  const [source, directory] = await Promise.all([lstat(executable), lstat(scratch)]);
  if (!source.isFile() || source.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()
    || directory.mode & 0o077 || typeof process.getuid === "function" && directory.uid !== process.getuid()) {
    throw Error("Fixture bundle requires an owned private scratch directory and regular executable");
  }
  const displayName = `ATools Dialog QA ${runId.slice(0, 8)}`;
  const bundleId = `dev.atools.fixture.dialog.${runId.replaceAll("-", "")}`;
  const bundlePath = join(await realpath(scratch), `${displayName}.app`);
  const contents = join(bundlePath, "Contents"), binaries = join(contents, "MacOS");
  await mkdir(bundlePath, { mode: 0o700 });
  await mkdir(contents, { mode: 0o700 });
  await mkdir(binaries, { mode: 0o700 });
  const staged = join(binaries, "AToolsDialogSmoke"), plistPath = join(contents, "Info.plist");
  await copyFile(executable, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  await chmod(staged, 0o700);
  const digest = async file => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  };
  const [sourceExecutableSha256, stagedExecutableSha256] = await Promise.all([digest(executable), digest(staged)]);
  if (sourceExecutableSha256 !== stagedExecutableSha256) throw Error("Staged native fixture executable differs from its build");
  await writeFile(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AToolsDialogSmoke</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${displayName}</string>
<key>CFBundleDisplayName</key><string>${displayName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSUIElement</key><false/>
</dict></plist>
`, { flag: "wx", mode: 0o600 });
  return { executable: staged, bundlePath, bundleId, plistPath, displayName,
    sourceExecutableSha256, stagedExecutableSha256 };
}
