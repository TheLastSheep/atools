import assert from "node:assert/strict";
import { createSourceFile, forEachChild, isFunctionDeclaration, ScriptTarget } from "typescript";
import { transformWithEsbuild } from "vite";

function findFunction(node, name) {
  if (isFunctionDeclaration(node) && node.name?.text === name) return node;
  let found;
  forEachChild(node, child => { found ??= findFunction(child, name); });
  return found;
}

async function compileFactory(source, name, filename, parameters, globals) {
  const ast = createSourceFile(filename, source, ScriptTarget.Latest, true);
  const declaration = findFunction(ast, name);
  assert.ok(declaration, `${filename} must retain its real ${name} factory`);
  const declarationText = declaration.getText(ast).replace(/^export\s+/, "");
  assert.ok(!declarationText.startsWith("export "), `${name} must be an executable local factory declaration`);
  const transformed = await transformWithEsbuild(declarationText, filename, {
    loader: "ts",
    target: "esnext",
  });
  const factory = new Function(...parameters, `${transformed.code}\nreturn ${name};`);
  return factory(...globals);
}

/** Execute the actual redirect -> plugin-session activation chain with inert native ports. */
export async function assertPluginRedirectHostPath(windowSource, sessionSource, helper) {
  const action = { code: "translate", feature_code: "translate", plugin_id: "plugin_translate", plugin_name: "聚合翻译", label: "翻译", score: 98, expand_height: 360 };
  const selected = { ...action, code: "translate", explain: "Translate text", icon: null, match_type: "label" };
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "search_features") return [selected];
    if (command === "activate_feature") return action;
    if (command === "expand_window") return undefined;
    throw Error("Unexpected native redirect command: " + command);
  };
  const state = {
    activePlugin: null, pluginActivationError: "", results: [selected], selectedIndex: 0, searchRunId: 0,
    pluginLifecycleNotice: null, webQuickOpenEntries: [], localLaunchEntries: [],
  };
  let clearReturnContextCount = 0;
  const sessionFactory = await compileFactory(
    sessionSource,
    "createLauncherPluginSessionController",
    "launcherPluginSessionController.ts",
    ["invoke", "SYSTEM_ACTIONS"],
    [invoke, []],
  );
  const session = sessionFactory({
    state,
    pluginCodeLifecycle: {
      beginActivation: () => "activation-1",
      start: async () => undefined,
      isCurrent: token => token === "activation-1",
    },
    contentSearch: { clear() {} },
    mediaSearch: { cancelIntake() {}, clear() {} },
    returnCoordinator: { invalidate() {} },
    returnContext: { clear() { clearReturnContextCount += 1; } },
    getMainPushHostInstance: () => null,
    activateSystemPanel: async () => undefined,
    openUrl: async () => undefined,
    openLocalLaunchEntry: async () => undefined,
    openLocalAppPath: async () => undefined,
    activatePastedResult: async () => undefined,
    activateTextQuickAction: async () => undefined,
  });
  const windowFactory = await compileFactory(
    windowSource,
    "createLauncherPluginWindowController",
    "launcherPluginWindowController.ts",
    ["invoke", "normalizePluginRedirectLabel", "selectPluginRedirectResult", "desktopSmokePluginQueueActionActive"],
    [invoke, helper.normalizePluginRedirectLabel, helper.selectPluginRedirectResult, () => false],
  );
  const windowController = windowFactory({
    isDetachWindow: false,
    hasTauriRuntime: () => true,
    activePlugin: () => state.activePlugin,
    setActivePlugin: value => { state.activePlugin = value; },
    setActivationError: value => { state.pluginActivationError = value; },
    lifecycle: { beginActivation: () => "detached", start: async () => undefined, isCurrent: () => true },
    onReturnToSearch: async () => undefined,
    resizePalette: async () => undefined,
    activateFeature: session.activateFeature,
    onEscape: async () => undefined,
    onSettingsRedirect: async () => false,
    onReady: () => undefined,
    onLoadError: () => undefined,
    desktopSmokeEnabled: () => false,
    smokeActions: () => [],
    smokeIndex: () => 0,
    smokeExternalPlan: () => false,
    onSmokeRender: async () => undefined,
  });

  for (const payload of ["hello", { text: "保留原始内容", count: 2 }, null]) {
    calls.length = 0;
    assert.equal(await windowController.handlePluginRedirect(["聚合翻译", "翻译"], payload), true);
    assert.deepEqual(calls, [
      { command: "search_features", args: { query: "翻译" } },
      { command: "activate_feature", args: { code: "translate", payload, expectedPluginId: "plugin_translate" } },
      { command: "expand_window", args: { height: action.expand_height } },
    ], "redirect must reach the actual session activation and preserve its native expand behavior");
    assert.equal(state.activePlugin, action, "session activation should commit the selected plugin");
    assert.equal(clearReturnContextCount, 0, "redirect activation must preserve launcher return context");
  }

  for (const invalid of ["", ["聚合翻译", ""]]) {
    calls.length = 0;
    await assert.rejects(windowController.handlePluginRedirect(invalid, "unused"), /non-empty/);
    assert.deepEqual(calls, []);
  }
  calls.length = 0;
  const nonDesktopWindow = windowFactory({
    isDetachWindow: false, hasTauriRuntime: () => false, activePlugin: () => null, setActivePlugin() {}, setActivationError() {},
    lifecycle: { beginActivation: () => "detached", start: async () => undefined, isCurrent: () => true },
    onReturnToSearch: async () => undefined, resizePalette: async () => undefined, activateFeature: session.activateFeature,
    onEscape: async () => undefined, onSettingsRedirect: async () => false, onReady() {}, onLoadError() {},
    desktopSmokeEnabled: () => false, smokeActions: () => [], smokeIndex: () => 0, smokeExternalPlan: () => false, onSmokeRender() {},
  });
  await assert.rejects(nonDesktopWindow.handlePluginRedirect("翻译", "unused"), /desktop runtime/);
  assert.deepEqual(calls, []);

  for (const [results, message] of [[[], /no plugin feature/], [[selected, { ...selected, plugin_id: "dictionary", plugin_name: "词典" }], /ambiguous/]]) {
    const rejectingInvoke = async (command, args) => {
      calls.push({ command, args });
      if (command === "search_features") return results;
      throw Error("Unexpected native redirect command: " + command);
    };
    const rejectingFactory = await compileFactory(
      windowSource, "createLauncherPluginWindowController", "launcherPluginWindowController.ts",
      ["invoke", "normalizePluginRedirectLabel", "selectPluginRedirectResult", "desktopSmokePluginQueueActionActive"],
      [rejectingInvoke, helper.normalizePluginRedirectLabel, helper.selectPluginRedirectResult, () => false],
    );
    calls.length = 0;
    const rejectingWindow = rejectingFactory({
      isDetachWindow: false, hasTauriRuntime: () => true, activePlugin: () => null, setActivePlugin() {}, setActivationError() {},
      lifecycle: { beginActivation: () => "detached", start: async () => undefined, isCurrent: () => true },
      onReturnToSearch: async () => undefined, resizePalette: async () => undefined, activateFeature: session.activateFeature,
      onEscape: async () => undefined, onSettingsRedirect: async () => false, onReady() {}, onLoadError() {},
      desktopSmokeEnabled: () => false, smokeActions: () => [], smokeIndex: () => 0, smokeExternalPlan: () => false, onSmokeRender() {},
    });
    await assert.rejects(rejectingWindow.handlePluginRedirect("翻译", "unused"), message);
    assert.deepEqual(calls, [{ command: "search_features", args: { query: "翻译" } }]);
  }
  const nativeFailure = new Error("search failed");
  const failingInvoke = async () => { throw nativeFailure; };
  const failingFactory = await compileFactory(
    windowSource, "createLauncherPluginWindowController", "launcherPluginWindowController.ts",
    ["invoke", "normalizePluginRedirectLabel", "selectPluginRedirectResult", "desktopSmokePluginQueueActionActive"],
    [failingInvoke, helper.normalizePluginRedirectLabel, helper.selectPluginRedirectResult, () => false],
  );
  const failingWindow = failingFactory({
    isDetachWindow: false, hasTauriRuntime: () => true, activePlugin: () => null, setActivePlugin() {}, setActivationError() {},
    lifecycle: { beginActivation: () => "detached", start: async () => undefined, isCurrent: () => true },
    onReturnToSearch: async () => undefined, resizePalette: async () => undefined, activateFeature: session.activateFeature,
    onEscape: async () => undefined, onSettingsRedirect: async () => false, onReady() {}, onLoadError() {},
    desktopSmokeEnabled: () => false, smokeActions: () => [], smokeIndex: () => 0, smokeExternalPlan: () => false, onSmokeRender() {},
  });
  await assert.rejects(failingWindow.handlePluginRedirect("翻译", "unused"), error => error === nativeFailure);
}
