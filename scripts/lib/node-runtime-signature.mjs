import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STREAM_BYTES = 64 * 1024;
const MAX_ENTITLEMENTS_BYTES = 64 * 1024;
const MAX_CODESIGN_OUTPUT_BYTES = 1024 * 1024;
const ENTITLEMENTS_NAME = "node-entitlements.plist";
const PLIST_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../resources/node-runtime", ENTITLEMENTS_NAME);
const PLIST_DTD = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
const APPROVED_KEYS = Object.freeze([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
].sort());

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function checkedText(value, label, limit = MAX_CODESIGN_OUTPUT_BYTES) {
  if (Buffer.isBuffer(value)) {
    if (value.length > limit) throw new Error(`${label} exceeded its byte budget`);
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit) throw new Error(`${label} exceeded its byte budget`);
  return value;
}

function exactApproved(values) {
  const keys = Object.keys(values).sort();
  return keys.length === APPROVED_KEYS.length && keys.every((key, index) => key === APPROVED_KEYS[index])
    && keys.every(key => values[key] === true);
}

// Parses only the boolean-only XML plist subset required by the fixed Node signing policy.
// It intentionally rejects entities, comments, arbitrary XML values, duplicate keys, and extensions.
export function parseApprovedEntitlementsXml(input) {
  const xml = checkedText(input, "Entitlements plist", MAX_ENTITLEMENTS_BYTES);
  let body = xml.trim();
  body = body.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/, "");
  if (body.startsWith(PLIST_DTD)) body = body.slice(PLIST_DTD.length).trimStart();
  const root = /^<plist version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>$/.exec(body);
  if (!root) throw new Error("Entitlements plist has an unsupported XML shape");
  let rest = root[1];
  const values = Object.create(null);
  while (rest.trim()) {
    const pair = /^\s*<key>([^<>&]+)<\/key>\s*<(true|false)\s*\/>/.exec(rest);
    if (!pair || Object.hasOwn(values, pair[1])) throw new Error("Entitlements plist has an invalid or duplicate key/value");
    values[pair[1]] = pair[2] === "true";
    rest = rest.slice(pair[0].length);
  }
  if (!exactApproved(values)) throw new Error("Entitlements plist differs from the approved Node runtime policy");
  return Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]]));
}

async function assertNoSymlinkPath(path) {
  if (!isAbsolute(path)) throw new Error("Entitlements paths must be absolute");
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let cursor = sep;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error("Symlink or non-directory in entitlements path");
  }
  return absolute;
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.uid === after.uid && before.nlink === after.nlink && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function readBoundedNoFollow(path, limit) {
  await assertNoSymlinkPath(path);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(limit)
      || before.mode & 0o022n || before.mode & 0o7000n
      || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
      throw new Error("Entitlements file must be a bounded private regular file owned by the current user");
    }
    const chunks = [];
    let bytes = 0;
    while (bytes < Number(before.size)) {
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_BYTES, Number(before.size) - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
      if (!bytesRead) throw new Error("Entitlements file ended before its descriptor size");
      bytes += bytesRead;
      if (bytes > limit) throw new Error("Entitlements file exceeded its byte budget");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after) || BigInt(bytes) !== after.size) throw new Error("Entitlements file changed while being read");
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

async function approvedPolicy() {
  const bytes = await readBoundedNoFollow(PLIST_PATH, MAX_ENTITLEMENTS_BYTES);
  return { bytes, sha256: sha256(bytes), values: parseApprovedEntitlementsXml(bytes) };
}

async function ownSnapshotDirectory(directory) {
  const path = await assertNoSymlinkPath(directory);
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.mode & 0o077n || (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid()))) {
    throw new Error("Entitlements snapshot directory must be private and owned by the current user");
  }
  return path;
}

export async function snapshotApprovedEntitlements(directory) {
  const policy = await approvedPolicy();
  const parent = await ownSnapshotDirectory(directory);
  const path = join(parent, `.node-entitlements-${randomUUID()}.plist`);
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
  let identity;
  try {
    await handle.writeFile(policy.bytes);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    identity = { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, nlink: stat.nlink, size: stat.size };
  } finally { await handle.close(); }
  const copied = await readBoundedNoFollow(path, MAX_ENTITLEMENTS_BYTES);
  if (sha256(copied) !== policy.sha256 || !copied.equals(policy.bytes)) {
    await removeOwnedSnapshot(path, identity);
    throw new Error("Entitlements snapshot differs from its bounded source bytes");
  }
  return { path, sha256: policy.sha256, values: policy.values, identity };
}

export async function removeOwnedSnapshot(path, identity) {
  if (!identity) return false;
  try {
    const current = await lstat(path, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
      || current.mode !== identity.mode || current.uid !== identity.uid || current.nlink !== identity.nlink || current.size !== identity.size) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function runDefaultCodesign(args) {
  if (process.platform !== "darwin") throw new Error("Apple code signing requires macOS");
  return execFileAsync("/usr/bin/codesign", args, { timeout: 15000, maxBuffer: MAX_CODESIGN_OUTPUT_BYTES, windowsHide: true, encoding: "buffer" });
}

export function validateTeam(team) {
  if (typeof team !== "string" || !/^[A-Z0-9]{10}$/.test(team)) throw new Error("An explicit expected Apple Team ID is required");
}

async function verifySignature(binary, expectedTeamId, runCodesign, expectedEntitlements) {
  validateTeam(expectedTeamId);
  const verification = await runCodesign(["--verify", "--strict", binary]);
  checkedText(verification?.stdout || "", "codesign verification output");
  checkedText(verification?.stderr || "", "codesign verification output");
  const details = await runCodesign(["--display", "--verbose=4", binary]);
  const text = `${checkedText(details?.stderr || "", "codesign display output")}\n${checkedText(details?.stdout || "", "codesign display output")}`;
  const teams = [...text.matchAll(/^TeamIdentifier=([^\r\n]+)$/gm)].map(match => match[1]);
  const authorities = [...text.matchAll(/^Authority=(Developer ID Application: [^\r\n]+)$/gm)].map(match => match[1]);
  const codeDirectory = /^CodeDirectory .*flags=([^\s]+).*$/m.exec(text)?.[1] || "";
  const timestamps = [...text.matchAll(/^Timestamp=([^\r\n]+)$/gm)].map(match => match[1]);
  if (teams.length !== 1 || teams[0] !== expectedTeamId || authorities.length !== 1 || !codeDirectory.includes("(runtime)")
      || timestamps.length !== 1 || !timestamps[0].trim() || timestamps[0].trim().toLowerCase() === "none") {
    throw new Error("Signed Node copy must have the expected Developer ID Team, hardened runtime, and secure timestamp");
  }
  const embedded = await runCodesign(["--display", "--entitlements", "-", "--xml", binary]);
  const xml = checkedText(embedded?.stdout || "", "embedded entitlements", MAX_ENTITLEMENTS_BYTES);
  const actualValues = parseApprovedEntitlementsXml(xml);
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedEntitlements.values)) {
    throw new Error("Signed Node entitlements differ from the approved JIT policy");
  }
  return expectedEntitlements.sha256;
}

export async function signAndVerify(binary, identity, expectedTeamId, runCodesign, entitlements) {
  if (typeof identity !== "string" || identity.length < 1 || identity.length > 256 || /[\0\r\n]/.test(identity)) throw new Error("An explicit signing identity is required");
  validateTeam(expectedTeamId);
  if (!entitlements?.path || !entitlements?.identity || !exactApproved(entitlements.values)) throw new Error("A fixed approved entitlements snapshot is required");
  await runCodesign(["--force", "--sign", identity, "--options", "runtime", "--timestamp", "--entitlements", entitlements.path, binary]);
  await verifySignature(binary, expectedTeamId, runCodesign, entitlements);
  return entitlements.sha256;
}

export async function verifyCompressedNodeSignature(binary, expectedTeamId, expectedEntitlementsSha256, runCodesign = runDefaultCodesign) {
  if (!/^[a-f\d]{64}$/.test(expectedEntitlementsSha256 || "")) throw new Error("Compressed payload entitlements hash is invalid");
  const policy = await approvedPolicy();
  if (policy.sha256 !== expectedEntitlementsSha256) throw new Error("Compressed payload entitlements policy SHA-256 mismatch");
  await verifySignature(binary, expectedTeamId, runCodesign, policy);
  return policy.sha256;
}
