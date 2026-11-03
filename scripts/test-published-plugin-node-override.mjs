import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { preparePublishedFixtureNodeRuntime } from "./lib/published-plugin-node-runtime.mjs";
import { requestedPublishedNodeBinaryPath, serializePublishedFixtureNodePathError,
  withSharedNodePathFilesystemErrors } from "./lib/published-fixture-node-override.mjs";

const target = process.arch === "arm64" ? "aarch64-apple-darwin" : process.arch === "x64" ? "x86_64-apple-darwin" : null;
const profile = { caseId: "converted-deepread-source", sourceKind: "converted_handoff_directory", runtime: "web" };
const execution = { executeReviewedPackage: true, buildOnly: false, workerContractOnly: false,
  nativeUiInput: false, nativeLaunchMode: "direct" };
assert.equal(requestedPublishedNodeBinaryPath({}, profile, execution), null);
assert.throws(() => requestedPublishedNodeBinaryPath({ nodeRuntimeBinaryPath: "/private/tmp/node" },
  { ...profile, caseId: "converted-tetris-source" }, execution), /restricted/);
for (const change of [{ buildOnly: true }, { executeReviewedPackage: false }, { workerContractOnly: true },
  { nativeUiInput: true }, { nativeLaunchMode: "launchservices" }]) {
  assert.throws(() => requestedPublishedNodeBinaryPath({ nodeRuntimeBinaryPath: "/private/tmp/node" },
    profile, { ...execution, ...change }), /restricted/);
}
assert.throws(() => requestedPublishedNodeBinaryPath({ nodeRuntimeBinaryPath: "/private/tmp/node", extra: true }, profile, execution), /Unknown/);
assert.throws(() => requestedPublishedNodeBinaryPath({ nodeRuntimeBinaryPath: 4 }, profile, execution), /invalid/);
const unrelatedError = new Error("unrelated verifier failure");
await assert.rejects(withSharedNodePathFilesystemErrors("test-stage", async () => { throw unrelatedError; }),
  error => error === unrelatedError, "non-filesystem failures are preserved");
const cancelledError = Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
await assert.rejects(withSharedNodePathFilesystemErrors("test-stage", async () => { throw cancelledError; }),
  error => error === cancelledError, "cancellation is preserved");

if (process.platform === "darwin") {
  assert.ok(target, "the native published fixture supports only pinned macOS arm64/x64 targets");
  const privateRoot = await mkdtemp("/private/tmp/atools-shared-node-control-");
  try {
    await chmod(privateRoot, 0o700);
    const binary = Buffer.from("synthetic pinned Node fixture bytes; never executed", "utf8");
    const binaryPath = join(privateRoot, `node-${target}`);
    await writeFile(binaryPath, binary, { flag: "wx", mode: 0o700 });
    await chmod(binaryPath, 0o700);
    const pin = { version: "v22.23.3", targets: { [target]: {
      binaryBytes: binary.length, binarySha256: createHash("sha256").update(binary).digest("hex"),
    } } };
    const makeRoot = async name => {
      const root = join(privateRoot, name);
      await mkdir(join(root, "resources/node-runtime"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, "resources/node-runtime/pin.json"), JSON.stringify(pin), { flag: "wx", mode: 0o600 });
      return root;
    };
    const roots = [await makeRoot("baseline"), await makeRoot("combined")];
    const results = [];
    const configuredPaths = [];
    for (const root of roots) {
      const environment = {};
      results.push(await preparePublishedFixtureNodeRuntime(profile, environment, root, { nodeRuntimeBinaryPath: binaryPath }));
      configuredPaths.push(environment.ATOOLS_NODE_BINARY);
    }
    assert.equal(configuredPaths[0], binaryPath);
    assert.equal(configuredPaths[1], binaryPath, "both graph roots configure the same canonical binary path");
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].sharedPrivateBinaryPath, true);
    assert.equal(results[0].binarySha256, pin.targets[target].binarySha256);

    const missingRoot = await mkdtemp("/private/tmp/atools-shared-node-missing-");
    try {
      await chmod(missingRoot, 0o700);
      const missingPath = join(missingRoot, `node-${target}`);
      let missingError;
      await assert.rejects(preparePublishedFixtureNodeRuntime(profile, {}, roots[0],
        { nodeRuntimeBinaryPath: missingPath }), error => {
          missingError = error;
          return error?.name === "PublishedFixtureNodePathError"
            && error.code === "SHARED_NODE_PATH_MISSING" && error.stage === "path-component-lstat";
        });
      const serializedMissingError = serializePublishedFixtureNodePathError(missingError);
      assert.equal(serializedMissingError.code, "SHARED_NODE_PATH_MISSING");
      assert.equal(serializedMissingError.stage, "path-component-lstat");
      for (const visible of [missingError.message, missingError.stack, JSON.stringify(serializedMissingError)]) {
        assert.equal(visible.includes(missingPath), false, "shared path errors never expose the supplied absolute path");
        assert.equal(visible.includes(basename(missingPath)), false, "shared path errors never expose the private leaf name");
      }
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }

    await chmod(privateRoot, 0o755);
    const publicRootEnvironment = {};
    await assert.rejects(preparePublishedFixtureNodeRuntime(profile, publicRootEnvironment, roots[0],
      { nodeRuntimeBinaryPath: binaryPath }), /mode 0700/);
    assert.equal(Object.hasOwn(publicRootEnvironment, "ATOOLS_NODE_BINARY"), false);
    await chmod(privateRoot, 0o700);

    await chmod(binaryPath, 0o722);
    const writableBinaryEnvironment = {};
    await assert.rejects(preparePublishedFixtureNodeRuntime(profile, writableBinaryEnvironment, roots[0],
      { nodeRuntimeBinaryPath: binaryPath }), /group\/world writable/);
    assert.equal(Object.hasOwn(writableBinaryEnvironment, "ATOOLS_NODE_BINARY"), false);
    await chmod(binaryPath, 0o700);

    const rejectedEnvironment = {};
    await assert.rejects(preparePublishedFixtureNodeRuntime({ caseId: "converted-tetris-source", runtime: "web" },
      rejectedEnvironment, roots[0], { nodeRuntimeBinaryPath: binaryPath }), /restricted/);
    assert.equal(Object.hasOwn(rejectedEnvironment, "ATOOLS_NODE_BINARY"), false);
    await assert.rejects(preparePublishedFixtureNodeRuntime({ ...profile, runtime: "node" }, {}, roots[0],
      { nodeRuntimeBinaryPath: binaryPath }), /restricted/);

    const wrongPinRoot = join(privateRoot, "wrong-pin");
    await mkdir(join(wrongPinRoot, "resources/node-runtime"), { recursive: true, mode: 0o700 });
    await writeFile(join(wrongPinRoot, "resources/node-runtime/pin.json"), JSON.stringify({
      ...pin, targets: { [target]: { ...pin.targets[target], binarySha256: "0".repeat(64) } },
    }), { flag: "wx", mode: 0o600 });
    const wrongPinEnvironment = {};
    await assert.rejects(preparePublishedFixtureNodeRuntime(profile, wrongPinEnvironment, wrongPinRoot,
      { nodeRuntimeBinaryPath: binaryPath }), /checksum mismatch/);
    assert.equal(Object.hasOwn(wrongPinEnvironment, "ATOOLS_NODE_BINARY"), false,
      "a pin mismatch is rejected before environment injection");

    const alias = `/private/tmp/atools-shared-node-alias-${randomUUID()}`;
    await symlink(privateRoot, alias);
    try {
      await assert.rejects(preparePublishedFixtureNodeRuntime(profile, {}, roots[0],
        { nodeRuntimeBinaryPath: join(alias, `node-${target}`) }), /symlink/);
    } finally { await unlink(alias); }

    const leafRoot = `/private/tmp/atools-shared-node-leaf-${randomUUID()}`;
    await mkdir(leafRoot, { mode: 0o700 });
    const leaf = join(leafRoot, `node-${target}`);
    await symlink(binaryPath, leaf);
    try {
      await assert.rejects(preparePublishedFixtureNodeRuntime(profile, {}, roots[0],
        { nodeRuntimeBinaryPath: leaf }), /symlink/);
    } finally { await rm(leafRoot, { recursive: true, force: true }); }
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
} else {
  assert.throws(() => requestedPublishedNodeBinaryPath({ nodeRuntimeBinaryPath: "/private/tmp/node" }, profile, execution));
}

process.stdout.write("Published fixture shared Node path contract passed; synthetic bytes were not executed\n");
