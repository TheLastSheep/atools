import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { fileDigest, MAX_ARCHIVE_BYTES } from "./lib/node-runtime-archive.mjs";
import { cleanupPreparedCompressedNodePayload, prepareCompressedNodePayload, verifyCompressedNodePayload } from "./lib/node-runtime-compressed-payload.mjs";
import { parseApprovedEntitlementsXml } from "./lib/node-runtime-signature.mjs";

const execFileAsync = promisify(execFile);
const TARGET = "aarch64-apple-darwin";
const TEAM = "TEAM123ABC";
const VERSION = "v22.23.3";
const PREFIX = `node-${VERSION}-darwin-arm64`;
const SIGNATURE = Buffer.from("\nfixture-signature", "utf8");
const digest = value => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atools-compressed-payload-test-")));
  const tree = join(root, "tree");
  const node = join(tree, PREFIX, "bin", "node");
  const licensePath = join(tree, PREFIX, "LICENSE");
  const archive = join(root, "official-node.tar.gz");
  const outputParent = join(root, "outputs");
  const binary = Buffer.alloc(1024 * 1024, 0x4e);
  const license = Buffer.from("fixture license\n");
  await mkdir(join(tree, PREFIX, "bin"), { recursive: true });
  await mkdir(outputParent);
  await writeFile(node, binary, { mode: 0o755 });
  await chmod(node, 0o755);
  await writeFile(licensePath, license);
  await execFileAsync("tar", ["-czf", archive, "-C", tree, `${PREFIX}/bin/node`, `${PREFIX}/LICENSE`], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const archiveInfo = await fileDigest(archive, MAX_ARCHIVE_BYTES);
  const pin = {
    version: VERSION,
    minimumMacOS: "11.0",
    targets: {
      [TARGET]: {
        archive: `node-${VERSION}-darwin-arm64.tar.gz`,
        sha256: archiveInfo.sha256,
        binarySha256: digest(binary),
        binaryBytes: binary.length,
        licenseSha256: digest(license),
      },
    },
  };
  const pinSha256 = digest(Buffer.from(`${JSON.stringify(pin, null, 2)}\n`));
  return { root, archive, outputParent, pin, pinSha256, originalArchiveSha256: archiveInfo.sha256, originalArchiveBytes: archiveInfo.bytes, originalBinary: binary };
}

function signingRunner({ team = TEAM, signed = true, authority = `Developer ID Application: fixture (${team})`, runtime = true, timestamp = "Oct 20, 2026 at 12:00:00 PM", embeddedEntitlements } = {}) {
  let signingCalls = 0;
  const signedPaths = [];
  let signedEntitlements = "";
  const run = async args => {
    if (args[0] === "--force") {
      signingCalls += 1;
      assert.equal(args[1], "--sign");
      assert.equal(args[2], "Developer ID Application: fixture");
      assert.deepEqual(args.slice(3, 8), ["--options", "runtime", "--timestamp", "--entitlements", args[7]]);
      assert.ok(args.at(-1).endsWith(`/node-${TARGET}`), "only the extracted Node copy is signed");
      assert.ok(args[7].endsWith(".plist"), "codesign receives a private fixed-policy snapshot");
      signedPaths.push(args.at(-1));
      signedEntitlements = embeddedEntitlements ?? await readFile(args[7], "utf8");
      if (signed) {
        const path = args.at(-1);
        const bytes = await readFile(path);
        await writeFile(path, Buffer.concat([bytes, SIGNATURE]));
      }
      return { stdout: "", stderr: "" };
    }
    assert.notEqual(args[0], "--force", "verification must not sign");
    if (args[0] === "--display" && args.includes("--entitlements")) {
      assert.deepEqual(args.slice(0, 4), ["--display", "--entitlements", "-", "--xml"]);
      assert.equal(args.length, 5, "embedded entitlement extraction targets only the verified binary");
      return { stdout: signedEntitlements, stderr: "" };
    }
    if (args[0] === "--display") return { stdout: "", stderr: `CodeDirectory v=20400 size=512 flags=${runtime ? "0x10000(runtime)" : "0x0"} hashes=12\nAuthority=${authority}\nTimestamp=${timestamp}\nTeamIdentifier=${team}\n` };
    assert.deepEqual(args.slice(0, 2), ["--verify", "--strict"], "verification remains strict and never signs");
    return { stdout: "", stderr: "" };
  };
  return { run, get signingCalls() { return signingCalls; }, signedPaths };
}

async function withFixture(callback) {
  const value = await fixture();
  try { await callback(value); } finally { await rm(value.root, { recursive: true, force: true }); }
}

describe("compressed pinned Node payload", () => {
  it("completes bounded descriptor archive copying, signs only the extracted copy, and round-trips gzip bytes", async () => {
    await withFixture(async input => {
      const signer = signingRunner();
      const result = await prepareCompressedNodePayload({
        pin: input.pin,
        pinSha256: input.pinSha256,
        target: TARGET,
        archive: input.archive,
        outputParent: input.outputParent,
        identity: "Developer ID Application: fixture",
        expectedTeamId: TEAM,
        runCodesign: signer.run,
      });
      assert.equal(signer.signingCalls, 1);
      assert.notEqual(signer.signedPaths[0], input.archive, "codesign must receive only the private extracted copy");
      assert.equal((await fileDigest(input.archive, MAX_ARCHIVE_BYTES)).sha256, input.originalArchiveSha256);
      assert.deepEqual(result.archive, { sha256: input.originalArchiveSha256, bytes: input.originalArchiveBytes });
      assert.equal(result.metadata.upstreamBinarySha256, digest(input.originalBinary));
      assert.notEqual(result.metadata.signedBinarySha256, result.metadata.upstreamBinarySha256);
      assert.equal(result.metadata.schemaVersion, 2);
      assert.match(result.metadata.entitlementsSha256, /^[a-f\d]{64}$/);
      assert.equal(result.metadata.entitlementsSha256, digest(await readFile(new URL("../resources/node-runtime/node-entitlements.plist", import.meta.url))));
      assert.deepEqual((await readdir(result.outputDirectory)).sort(), ["NODE-LICENSE", "compressed-runtime.json", `node-${TARGET}.gz`].sort());
      const verified = await verifyCompressedNodePayload({ pin: input.pin, pinSha256: input.pinSha256, target: TARGET, packageDirectory: result.outputDirectory, expectedTeamId: TEAM, runCodesign: signer.run });
      assert.equal(verified.passed, true);
      assert.equal(signer.signingCalls, 1, "verification must not invoke signing");
    });
  });

  it("can execute the verified decompressed binary with the fixed target probe", async () => {
    await withFixture(async input => {
      const signer = signingRunner();
      const result = await prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signer.run,
      });
      try {
        const verification = await verifyCompressedNodePayload({
          pin: input.pin,
          pinSha256: input.pinSha256,
          target: TARGET,
          packageDirectory: result.outputDirectory,
          expectedTeamId: TEAM,
          runCodesign: signer.run,
          execute: true,
          runNodeProbe: async (binary, target, version) => {
            assert.equal(binary.endsWith("/node"), true);
            assert.equal(target, TARGET);
            return {
              version,
              arch: "arm64",
              platform: "darwin",
              sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            };
          },
        });
        assert.equal(verification.runtimeExecutionVerified, true);
        assert.deepEqual(verification.runtime, {
          version: VERSION,
          arch: "arm64",
          platform: "darwin",
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        });
        await assert.rejects(() => verifyCompressedNodePayload({
          pin: input.pin,
          pinSha256: input.pinSha256,
          target: TARGET,
          packageDirectory: result.outputDirectory,
          expectedTeamId: TEAM,
          runCodesign: signer.run,
          execute: true,
          runNodeProbe: async () => ({
            version: VERSION,
            arch: "x64",
            platform: "darwin",
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          }),
        }), /target runtime probe/);
      } finally {
        await cleanupPreparedCompressedNodePayload(result);
      }
    });
  });

  it("accepts only the fixed true-valued JIT entitlement plist and rejects extra or mistyped keys", async () => {
    const approved = await readFile(new URL("../resources/node-runtime/node-entitlements.plist", import.meta.url));
    const parsed = parseApprovedEntitlementsXml(approved);
    assert.deepEqual(parsed, {
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.cs.disable-library-validation": true,
    });
    const text = approved.toString("utf8");
    assert.throws(() => parseApprovedEntitlementsXml(text.replace("</dict>", "  <key>get-task-allow</key>\n  <true/>\n</dict>")), /approved Node runtime policy/);
    assert.throws(() => parseApprovedEntitlementsXml(text.replace("</dict>", "  <key>com.apple.security.cs.allow-dyld-environment-variables</key>\n  <true/>\n</dict>")), /approved Node runtime policy/);
    assert.throws(() => parseApprovedEntitlementsXml(text.replace("<key>com.apple.security.cs.allow-jit</key>\n  <true/>", "<key>com.apple.security.cs.allow-jit</key>\n  <false/>")), /approved Node runtime policy/);
    assert.throws(() => parseApprovedEntitlementsXml(text.replace("<true/>", "<string>true</string>")), /invalid or duplicate key\/value/);
    assert.throws(() => parseApprovedEntitlementsXml(text.replace("</dict>", "  <key>com.apple.security.cs.allow-jit</key>\n  <true/>\n</dict>")), /invalid or duplicate key\/value/);
    const entityDtd = text.replace(/<!DOCTYPE plist[^>]*>/, '<!DOCTYPE plist [<!ENTITY x SYSTEM "file:///etc/passwd">]>');
    assert.throws(() => parseApprovedEntitlementsXml(entityDtd.replace("<true/>", "<true/>\n  <key>&x;</key>")), /unsupported XML shape/);
    assert.throws(() => parseApprovedEntitlementsXml(text.replace("</dict>", "<!-- comment --></dict>")), /invalid or duplicate key\/value/);
    assert.throws(() => parseApprovedEntitlementsXml(Buffer.from("bplist00\x00\x01\x02", "binary")), /unsupported XML shape/);
    assert.throws(() => parseApprovedEntitlementsXml(`${text} trailing-data`), /unsupported XML shape/);
  });

  it("rejects signatures that embed extra entitlements even when the code-signature metadata is valid", async () => {
    await withFixture(async input => {
      const approved = await readFile(new URL("../resources/node-runtime/node-entitlements.plist", import.meta.url), "utf8");
      const signer = signingRunner({ embeddedEntitlements: approved.replace("</dict>", "  <key>get-task-allow</key>\n  <true/>\n</dict>") });
      await assert.rejects(prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signer.run,
      }), /approved Node runtime policy/);
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("rejects changed pin bytes before reading the archive and removes only its fresh output directory", async () => {
    await withFixture(async input => {
      const changedPin = structuredClone(input.pin);
      changedPin.targets[TARGET].sha256 = "0".repeat(64);
      await assert.rejects(prepareCompressedNodePayload({
        pin: changedPin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signingRunner().run,
      }), /pin bytes do not match/);
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("rejects an archive whose bytes disagree with the newly bound pin", async () => {
    await withFixture(async input => {
      const changedPin = structuredClone(input.pin);
      changedPin.targets[TARGET].sha256 = "0".repeat(64);
      const changedPinSha256 = digest(Buffer.from(`${JSON.stringify(changedPin, null, 2)}\n`));
      await assert.rejects(prepareCompressedNodePayload({
        pin: changedPin, pinSha256: changedPinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signingRunner().run,
      }), /Pinned Node archive SHA-256 mismatch/);
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("rejects symlink archive inputs without following them", async () => {
    await withFixture(async input => {
      const linkedArchive = join(input.root, "linked-node.tar.gz");
      await symlink(input.archive, linkedArchive);
      await assert.rejects(prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: linkedArchive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signingRunner().run,
      }), /Symlink filesystem paths/);
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("rejects an unexpected signing Team and leaves no partial package", async () => {
    await withFixture(async input => {
      await assert.rejects(prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signingRunner({ team: "OTHER12345" }).run,
      }), /expected Developer ID Team, hardened runtime, and secure timestamp/);
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("rejects signatures missing Developer ID authority, hardened runtime, or secure timestamp", async () => {
    await withFixture(async input => {
      for (const signer of [
        signingRunner({ authority: "Apple Development: fixture (TEAM123ABC)" }),
        signingRunner({ runtime: false }),
        signingRunner({ timestamp: "none" }),
      ]) {
        await assert.rejects(prepareCompressedNodePayload({
          pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
          identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signer.run,
        }), /Developer ID Team, hardened runtime, and secure timestamp/);
        assert.deepEqual(await readdir(input.outputParent), []);
      }
    });
  });

  it("rejects compressed-byte tampering before signature acceptance", async () => {
    await withFixture(async input => {
      const signer = signingRunner();
      const result = await prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signer.run,
      });
      const compressedPath = join(result.outputDirectory, `node-${TARGET}.gz`);
      const bytes = await readFile(compressedPath);
      bytes[bytes.length - 1] ^= 0xff;
      await writeFile(compressedPath, bytes);
      await assert.rejects(verifyCompressedNodePayload({ pin: input.pin, pinSha256: input.pinSha256, target: TARGET, packageDirectory: result.outputDirectory, expectedTeamId: TEAM, runCodesign: signer.run }), /hash mismatch/);
      assert.equal(await cleanupPreparedCompressedNodePayload(result), true, "CLI can remove only its owned output after verification failure");
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("binds schema-v2 metadata to the exact approved entitlements bytes", async () => {
    await withFixture(async input => {
      const signer = signingRunner();
      const result = await prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signer.run,
      });
      const metadataPath = join(result.outputDirectory, "compressed-runtime.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.entitlementsSha256 = "0".repeat(64);
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      await assert.rejects(verifyCompressedNodePayload({ pin: input.pin, pinSha256: input.pinSha256, target: TARGET,
        packageDirectory: result.outputDirectory, expectedTeamId: TEAM, runCodesign: signer.run }), /entitlements policy SHA-256 mismatch/);
      assert.equal(await cleanupPreparedCompressedNodePayload(result), true);
      assert.deepEqual(await readdir(input.outputParent), []);
    });
  });

  it("does not remove an output path replaced after preparation", async () => {
    await withFixture(async input => {
      const result = await prepareCompressedNodePayload({
        pin: input.pin, pinSha256: input.pinSha256, target: TARGET, archive: input.archive, outputParent: input.outputParent,
        identity: "Developer ID Application: fixture", expectedTeamId: TEAM, runCodesign: signingRunner().run,
      });
      const replacement = `${result.outputDirectory}.replacement`;
      await rename(result.outputDirectory, replacement);
      await mkdir(result.outputDirectory);
      await writeFile(join(result.outputDirectory, "preserve-me"), "outside replacement");
      assert.equal(await cleanupPreparedCompressedNodePayload(result), false);
      assert.deepEqual(await readdir(result.outputDirectory), ["preserve-me"]);
    });
  });
});
