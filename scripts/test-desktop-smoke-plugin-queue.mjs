import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const rootRequire = createRequire(import.meta.url);
const vitePackagePath = rootRequire.resolve("vite/package.json");
const { build } = createRequire(resolve(vitePackagePath))("esbuild");
const queueSource = resolve(rootPath, "src/lib/desktopSmokePluginQueue.ts");
const controllerSource = resolve(rootPath, "src/lib/launcherPluginWindowController.ts");
const outDir = await mkdtemp(join(rootPath, ".tmp-desktop-smoke-plugin-queue-"));

console.log("Scope: queue policy and production PluginPanel props only; this is not App/UI acceptance.");

try {
  for (const source of [queueSource, controllerSource]) {
    let exists = true;
    try {
      await access(source, constants.R_OK);
    } catch {
      exists = false;
    }
    assert.equal(exists, true, `required production module must exist: ${basename(source)}`);
  }

  const bundled = await build({
    entryPoints: [queueSource, controllerSource],
    bundle: true,
    write: false,
    outdir: outDir,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@tauri-apps/api/core"],
  });
  for (const output of bundled.outputFiles) {
    await writeFile(output.path, output.contents);
  }

  const moduleAt = (name) => {
    const output = bundled.outputFiles.find((file) => basename(file.path) === name);
    assert.ok(output, `esbuild must emit ${name}`);
    return import(pathToFileURL(output.path).href);
  };
  const [queueModule, controllerModule] = await Promise.all([
    moduleAt("desktopSmokePluginQueue.mjs"),
    moduleAt("launcherPluginWindowController.mjs"),
  ]);
  const queueActionActive = queueModule.desktopSmokePluginQueueActionActive;
  assert.equal(typeof queueActionActive, "function");
  assert.equal(typeof controllerModule.createLauncherPluginWindowController, "function");

  const queued = {
    plugin_id: "timestamp",
    feature_code: "timestamp",
    plugin_path: "/plugins/timestamp",
    main_url: "index.html",
  };
  const other = {
    plugin_id: "calculator",
    feature_code: "calculator",
    plugin_path: "/plugins/calculator",
    main_url: "index.html",
  };
  const actions = [queued, other];

  assert.equal(queueActionActive(false, queued, [queued], 0), false, "disabled smoke env must not unlock a queue action");
  assert.equal(queueActionActive(true, queued, [], 0), false, "empty smoke queue must not unlock ordinary PluginPanel props");
  assert.equal(queueActionActive(true, queued, [queued], -1), false, "negative queue indexes are invalid");
  assert.equal(queueActionActive(true, queued, [queued], 1), false, "out-of-range queue indexes are invalid");
  assert.equal(queueActionActive(true, other, [queued], 0), false, "an unmatched action must not unlock smoke permissions");
  assert.equal(queueActionActive(true, other, [queued, other], 0), false, "switching away from the selected queue identity must revoke smoke props");
  assert.equal(queueActionActive(true, other, [queued, other], 1), true, "the action at the selected queue index is active");
  assert.equal(queueActionActive(true, queued, [queued], 0), true);
  assert.equal(queueActionActive(true, { ...queued }, [queued], 0), true, "stable action identity may survive serialization/cloning");
  assert.equal(queueActionActive(true, { ...queued, plugin_path: "/plugins/forged" }, [queued], 0), false, "forged identities must be rejected");
  assert.equal(queueActionActive(true, { ...queued, main_url: "other.html" }, [queued], 0), false);

  let smokeEnabled = true;
  let smokeActions = actions;
  let smokeIndex = 0;
  const smokePlanCalls = [];
  const readyCalls = [];
  const loadErrorCalls = [];
  const onclose = () => undefined;
  const onescape = () => undefined;
  const onsettingsredirect = () => true;
  const onSmokeRender = () => undefined;
  const ports = {
    isDetachWindow: false,
    hasTauriRuntime: () => false,
    activePlugin: () => null,
    setActivePlugin: () => undefined,
    setActivationError: () => undefined,
    lifecycle: {
      beginActivation: () => 0,
      start: async () => undefined,
      isCurrent: () => false,
    },
    onReturnToSearch: onclose,
    activateFeature: async () => undefined,
    resizePalette: () => undefined,
    onEscape: onescape,
    onSettingsRedirect: onsettingsredirect,
    onReady: (featureCode) => readyCalls.push(featureCode),
    onLoadError: (error) => loadErrorCalls.push(error),
    desktopSmokeEnabled: () => smokeEnabled,
    smokeActions: () => smokeActions,
    smokeIndex: () => smokeIndex,
    smokeExternalPlan: (action) => {
      smokePlanCalls.push(action);
      return action?.feature_code === "timestamp";
    },
    onSmokeRender,
  };
  const controller = controllerModule.createLauncherPluginWindowController(ports);

  function assertNoSmokeProps(action, label) {
    const props = controller.pluginPanelProps(action);
    assert.strictEqual(props.action, action, `${label}: action identity is preserved`);
    assert.equal(props.desktopSmokeExpectedSamples, 0, `${label}: expected sample count is zero`);
    assert.equal(props.desktopSmokeSampleIndex, 0, `${label}: sample index is zero`);
    assert.equal(props.desktopSmokeExternalPlanSample, false, `${label}: external plan is disabled`);
    assert.equal(props.ondesktopsmokerender, undefined, `${label}: render callback is omitted`);
    assert.equal(typeof props.onready, "function", `${label}: regular ready callback remains wired`);
    assert.equal(typeof props.onloaderror, "function", `${label}: regular error callback remains wired`);
    assert.strictEqual(props.onclose, onclose);
    assert.strictEqual(props.onescape, onescape);
    assert.strictEqual(props.onsettingsredirect, onsettingsredirect);
    assert.strictEqual(props.onredirect, controller.handlePluginRedirect);
    return props;
  }

  function assertSmokeProps(action, expectedIndex, label) {
    const props = controller.pluginPanelProps(action);
    assert.strictEqual(props.action, action, `${label}: action identity is preserved`);
    assert.equal(props.desktopSmokeExpectedSamples, actions.length, `${label}: sample count reflects the queue`);
    assert.equal(props.desktopSmokeSampleIndex, expectedIndex, `${label}: selected sample index is passed through`);
    assert.equal(props.desktopSmokeExternalPlanSample, action.feature_code === "timestamp", `${label}: external plan is scoped to the sample`);
    assert.strictEqual(props.ondesktopsmokerender, onSmokeRender, `${label}: queue render callback is wired`);
    assert.equal(typeof props.onready, "function");
    assert.equal(typeof props.onloaderror, "function");
    assert.strictEqual(props.onclose, onclose);
    assert.strictEqual(props.onescape, onescape);
    assert.strictEqual(props.onsettingsredirect, onsettingsredirect);
    assert.strictEqual(props.onredirect, controller.handlePluginRedirect);
    return props;
  }

  const selectedProps = assertSmokeProps(queued, 0, "enabled selected queue identity");
  assert.deepEqual(smokePlanCalls, [queued], "external-plan lookup only runs for an active queue identity");
  await selectedProps.onready();
  assert.deepEqual(readyCalls, [queued.feature_code], "ready callback reports the action feature code");
  await selectedProps.onloaderror("plugin load failed");
  assert.equal(loadErrorCalls.length, 1);
  assert.ok(loadErrorCalls[0] instanceof Error);
  assert.equal(loadErrorCalls[0].message, "plugin load failed");

  smokeEnabled = false;
  assertNoSmokeProps(queued, "disabled smoke environment");
  smokeEnabled = true;

  smokeActions = [];
  assertNoSmokeProps(queued, "empty smoke queue");
  smokeActions = actions;

  smokeIndex = -1;
  assertNoSmokeProps(queued, "negative queue index");
  smokeIndex = actions.length;
  assertNoSmokeProps(queued, "out-of-range queue index");

  smokeIndex = 0;
  const ordinaryProps = assertNoSmokeProps(other, "ordinary unmatched action");
  await ordinaryProps.onready();
  assert.deepEqual(readyCalls, [queued.feature_code, other.feature_code], "ordinary ready callback remains functional");
  const externalPlanCallsBeforeInvalidIdentities = smokePlanCalls.length;
  assertNoSmokeProps({ ...queued, plugin_path: "/plugins/forged" }, "forged action identity");
  assert.equal(smokePlanCalls.length, externalPlanCallsBeforeInvalidIdentities, "invalid queue identities never inspect external plans");

  const clonedProps = assertSmokeProps({ ...queued }, 0, "cloned stable queue identity");
  assert.equal(smokePlanCalls.at(-1), clonedProps.action, "external-plan lookup uses the active cloned action");

  smokeIndex = 1;
  assertSmokeProps(other, 1, "second queued identity");
  assertNoSmokeProps(queued, "previous queue identity after switching index");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
