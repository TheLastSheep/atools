import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePublishedFixtureNodeRuntime, profileRequiresPinnedNodeRuntime } from "./lib/published-plugin-node-runtime.mjs";

const target = process.arch === "arm64" ? "aarch64-apple-darwin" : process.arch === "x64" ? "x86_64-apple-darwin" : null;
assert.ok(target, "the native published fixture supports only pinned macOS arm64/x64 targets");
const deepRead = { caseId: "converted-deepread-source", runtime: "web" };
const tetris = { caseId: "converted-tetris-source", runtime: "web" };
const todo = { caseId: "converted-todo-neo-source", runtime: "web" };
const nodeProfile = { caseId: "regex-editor", runtime: "node" };
assert.equal(profileRequiresPinnedNodeRuntime(deepRead), true);
assert.equal(profileRequiresPinnedNodeRuntime(nodeProfile), true);
assert.equal(profileRequiresPinnedNodeRuntime(tetris), false);
assert.equal(profileRequiresPinnedNodeRuntime(todo), false);

const root = await mkdtemp(join(tmpdir(), "atools-published-node-fixture-"));
try {
  const binary = Buffer.from("synthetic-node-pin-fixture; never executed", "utf8");
  const binaryPath = join(root, "src-tauri/binaries/node-" + target);
  await mkdir(join(root, "src-tauri/binaries"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "resources/node-runtime"), { recursive: true, mode: 0o700 });
  await writeFile(binaryPath, binary, { flag: "wx", mode: 0o700 });
  await chmod(binaryPath, 0o700);
  const pin = { version: "v22.23.3", targets: { [target]: {
    binaryBytes: binary.length, binarySha256: createHash("sha256").update(binary).digest("hex"),
  } } };
  const pinPath = join(root, "resources/node-runtime/pin.json");
  await writeFile(pinPath, JSON.stringify(pin), { flag: "wx", mode: 0o600 });
  const environment = {};
  const result = await preparePublishedFixtureNodeRuntime(deepRead, environment, root);
  assert.deepEqual(result, { required: true, configured: true, version: "v22.23.3", binarySha256: pin.targets[target].binarySha256 });
  assert.equal(environment.ATOOLS_NODE_BINARY, binaryPath);
  const nodeEnvironment = {};
  assert.deepEqual(await preparePublishedFixtureNodeRuntime(nodeProfile, nodeEnvironment, root), result);
  assert.equal(nodeEnvironment.ATOOLS_NODE_BINARY, binaryPath);
  const webEnvironment = { ATOOLS_NODE_BINARY: "preserve-existing-value" };
  assert.deepEqual(await preparePublishedFixtureNodeRuntime(tetris, webEnvironment, root), { required: false, configured: false });
  assert.equal(webEnvironment.ATOOLS_NODE_BINARY, "preserve-existing-value");

  pin.targets[target].binarySha256 = "0".repeat(64);
  await writeFile(pinPath, JSON.stringify(pin), { flag: "w" });
  const invalidEnvironment = {};
  await assert.rejects(preparePublishedFixtureNodeRuntime(deepRead, invalidEnvironment, root), /checksum mismatch/);
  assert.equal(Object.hasOwn(invalidEnvironment, "ATOOLS_NODE_BINARY"), false,
    "an invalid pinned binary must fail before the native smoke process can be configured");
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write("Published fixture Node requirement and pin tests passed\n");
