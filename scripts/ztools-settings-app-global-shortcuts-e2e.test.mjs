import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyReviewedRendererCompatibilityPatch } from "../packages/ztools-renderer/upstream-compatibility-patches.mjs";
import { settingsSourceCompatibilityPatches } from "../packages/ztools-settings/src/compatibility-patches/index.mjs";
import { appGlobalShortcutEntryChange } from "../packages/ztools-settings/src/compatibility-patches/app-global-shortcuts.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import { frozenSettingsResourceBudget } from "./lib/ztools-settings-resource-budget.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = "/Users/harris/Desktop/ZTools";
const localRequire = createRequire(import.meta.url);
const upstreamRequire = createRequire(path.join(upstreamRoot, "package.json"));
const pnpmRequire = createRequire(path.join(upstreamRoot, "node_modules/.pnpm/package.json"));

const ts = localRequire("typescript");
const { JSDOM } = localRequire("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", {
  url: "https://atools.local/#/shortcuts",
   pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
const vue = upstreamRequire("vue");
const compiler = createRequire(pnpmRequire.resolve("@vue/compiler-sfc"))("@vue/compiler-sfc");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function transpileTs(source, fileName) {
  try {
    return ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
      fileName,
    }).outputText;
  } catch (err) {
    throw new Error(`transpileTs failed for ${fileName}: ${err.message}`);
  }
}

const tsModuleCache = new Map();

function loadTsModule(relativePath, requireMap = {}) {
  const fullPath = path.resolve(repoRoot, relativePath);
  if (tsModuleCache.has(fullPath)) {
    return tsModuleCache.get(fullPath).exports;
  }
  const source = readFileSync(fullPath, "utf8");
  const transpiled = transpileTs(source, fullPath);
  const mod = { exports: {} };
  tsModuleCache.set(fullPath, mod);
  const dir = path.dirname(fullPath);
  new Function("require", "module", "exports", transpiled)(
    (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith(".")) {
        const resolved = path.resolve(dir, id.endsWith(".ts") ? id : `${id}.ts`);
        return loadTsModule(path.relative(repoRoot, resolved), requireMap);
      }
      return localRequire(id);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}

function applySettingsPatch(relativePath) {
  const original = readFileSync(path.join(upstreamRoot, relativePath), "utf8");
  const descriptor = settingsSourceCompatibilityPatches.find((item) => item.path === relativePath);
  if (!descriptor) {
    return { original, patched: original, templateUnchanged: true, stylesUnchanged: true };
  }
  assert.equal(sha256(original), descriptor.beforeSha256);
  let patched = original;
  for (const change of descriptor.changes) {
    assert.equal(patched.split(change.before).length, 2, `unique change ${change.id}`);
    patched = patched.replace(change.before, () => change.after);
  }
  if (relativePath.endsWith(".vue")) {
    const beforeParsed = compiler.parse(original).descriptor;
    const afterParsed = compiler.parse(patched).descriptor;
    assert.equal(afterParsed.template?.content ?? null, beforeParsed.template?.content ?? null);
    assert.deepEqual(
      afterParsed.styles.map((style) => style.content),
      beforeParsed.styles.map((style) => style.content),
    );
  }
  return { original, patched, templateUnchanged: true, stylesUnchanged: true };
}

function compileVueSfc(source, id, requireResolver) {
  const parsed = compiler.parse(source, { filename: `${id}.vue` }).descriptor;
  const compiled = compiler.compileScript(parsed, {
    id,
    inlineTemplate: true,
  });
  const code = transpileTs(compiled.content, `${id}.ts`);
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(requireResolver, mod, mod.exports);
  return mod.exports.default;
}

async function flushVue(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await vue.nextTick();
  }
}

test("R80 formal Main and Settings distributions stay within byte budgets and preserve original Vue templates/CSS", () => {
  const mainLock = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/ztools-renderer/source-manifest.json"), "utf8"),
  );
  const mainDist = path.join(repoRoot, "packages/ztools-renderer/dist");
  const mainBuildProvenance = JSON.parse(
    readFileSync(path.join(mainDist, "build-provenance.json"), "utf8"),
  );
  validateRendererNativeProvenance(
    mainLock,
    mainBuildProvenance,
    {
      commit: mainBuildProvenance.sourceCommit,
      dirty: "",
      files: mainBuildProvenance.sourceFiles,
      sha256: mainBuildProvenance.sourceTreeSha256,
    },
    mainBuildProvenance.bundle.totalJavaScriptBytes,
  );
  assert.equal(mainLock.build.budgetMilestone, "original-vue-main-about-update-2026-11-02");
  assert.ok(
    mainBuildProvenance.bundle.totalJavaScriptBytes <= mainLock.build.totalJavaScriptBudgetBytes,
  );

  const settingsLock = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/ztools-settings/source-manifest.json"), "utf8"),
  );
  const settingsProvenance = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/ztools-settings/dist/build-provenance.json"), "utf8"),
  );
  const settingsBudget = frozenSettingsResourceBudget(
    settingsLock,
    settingsProvenance.source.commit,
  );
  assert.equal(
    settingsLock.build.budgetMilestone,
    "original-vue-app-global-shortcuts-settings-2026-11-02",
  );
  assert.ok(settingsProvenance.emittedResourceTotalBytes <= settingsBudget.maxBytes);

  const searchResultsPath = "src/renderer/src/components/search/SearchResults.vue";
  const searchResultsOriginal = readFileSync(path.join(upstreamRoot, searchResultsPath), "utf8");
  const searchResultsPatched = applyReviewedRendererCompatibilityPatch(
    searchResultsPath,
    searchResultsOriginal,
  );
  const beforeSearch = compiler.parse(searchResultsOriginal).descriptor;
  const afterSearch = compiler.parse(searchResultsPatched.code).descriptor;
  assert.equal(afterSearch.template?.content, beforeSearch.template?.content);
  assert.deepEqual(
    afterSearch.styles.map((s) => s.content),
    beforeSearch.styles.map((s) => s.content),
  );

  for (const sfcPath of [
    "internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue",
    "internal-plugins/setting/src/components/common/ShortcutEditor/ShortcutEditor.vue",
    "internal-plugins/setting/src/views/ShortcutsSetting/components/CommandTargetSelector.vue",
    "internal-plugins/setting/src/components/common/HotkeyInput/HotkeyInput.vue",
  ]) {
    const res = applySettingsPatch(sfcPath);
    assert.equal(res.templateUnchanged, true);
    assert.equal(res.stylesUnchanged, true);
  }
});

test("Main context menu -> cold/warm Settings Child prefill, actual App selection and same-name disambiguation end-to-end", async () => {
  dom.window.document.body.innerHTML = "<div id='app'></div>";
  try {
    const { createRendererContextMenu } = loadTsModule("packages/ztools-renderer/src/contextMenu.ts");
    const { createRendererAppLaunchTargets } = loadTsModule(
      "packages/ztools-renderer/src/appLaunchTargets.ts",
    );
    const { installAppShortcutIntentReceiver } = loadTsModule(
      "packages/ztools-settings/src/appShortcutIntent.ts",
    );
    const { createAppGlobalShortcutsController } = loadTsModule(
      "packages/ztools-settings/src/appGlobalShortcutsController.ts",
    );

    const sameAppA = {
      name: "Same",
      path: "/Applications/Same.app",
      type: "direct",
      subType: "app",
      cmdType: "text",
    };
    const sameAppB = {
      name: "Same",
      path: "/Users/harris/Applications/Same.app",
      type: "direct",
      subType: "app",
      cmdType: "text",
    };
    const localShortcutItem = {
      name: "Same",
      path: "/Users/harris/Desktop/Same.command",
      type: "direct",
      subType: "local-shortcut",
      cmdType: "text",
    };

    // 1. Verify patched SearchResults.vue context menu generation & command handler on same-named apps
    const searchResultsPath = "src/renderer/src/components/search/SearchResults.vue";
    const searchResultsOriginal = readFileSync(path.join(upstreamRoot, searchResultsPath), "utf8");
    const searchResultsPatched = applyReviewedRendererCompatibilityPatch(
      searchResultsPath,
      searchResultsOriginal,
    ).code;
    assert.ok(
      searchResultsPatched.includes(
        "id: `add-global-shortcut:${JSON.stringify({ path: app.path, name: app.name, subType: app.subType === 'app' && app.type === 'direct' ? 'app' : undefined })}`",
      ),
    );

    let deliverMenuSelection = () => {};
    const shownMenus = [];
    const contextMenu = createRendererContextMenu({
      transport: {
        listen: async (_event, cb) => {
          deliverMenuSelection = cb;
          return () => {};
        },
      },
      show: async (items) => {
        shownMenus.push(items);
      },
    });
    const receivedMenuCommands = [];
    contextMenu.subscribe((commandId) => receivedMenuCommands.push(commandId));
    await flushVue(2);

    const buildMoreMenuFor = (app) => [
      {
        label: "更多",
        submenu: [
          {
            id: `add-global-shortcut:${JSON.stringify({
              path: app.path,
              name: app.name,
              subType: app.subType === "app" && app.type === "direct" ? "app" : undefined,
            })}`,
            label: "设置全局快捷键",
          },
        ],
      },
    ];

    // Local shortcut must NOT produce an enabled add-global-shortcut item
    await contextMenu.showContextMenu(buildMoreMenuFor(localShortcutItem));
    assert.deepEqual(shownMenus.at(-1), [
      { id: "atools-disabled-menu-item", label: "更多", enabled: false },
    ]);

    // Same-named App A produces an enabled add-global-shortcut item with App A's exact path
    await contextMenu.showContextMenu(buildMoreMenuFor(sameAppA));
    const appAMenuId = shownMenus.at(-1)[0].submenu[0].id;
    assert.equal(
      appAMenuId,
      `add-global-shortcut:${JSON.stringify({ path: sameAppA.path, name: "Same", subType: "app" })}`,
    );

    // 2. Wire Main launch target authority -> Settings Child intent delivery
    const sessionId = "b".repeat(32);
    const ackCalls = [];
    let nextSequence = 0;
    const stopReceiver = installAppShortcutIntentReceiver(
      dom.window,
      sessionId,
      async (ack) => {
        ackCalls.push(ack);
        return { acknowledged: true };
      },
    );

    const jumpListeners = [];
    const routerReplaceCalls = [];
    const router = {
      replace: async (route) => {
        routerReplaceCalls.push(route);
        for (const fn of [...jumpListeners]) {
          await fn(route.state || {});
        }
      },
    };

    // Install patched Settings main.ts intent listener
    const mainTsPatch = settingsSourceCompatibilityPatches.find(
      (item) => item.path === "internal-plugins/setting/src/main.ts",
    );
    assert.ok(mainTsPatch.changes.some((c) => c.id === appGlobalShortcutEntryChange.id));
    dom.window.addEventListener("atools-app-shortcuts-intent", (event) => {
      const intent = event.detail;
      if (!intent || intent.target?.kind !== "app") return;
      const finish = dom.window.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__;
      void Promise.resolve()
        .then(() =>
          router.replace({
            name: "Shortcuts",
            query: { _t: String(intent.sequence) },
            state: { appShortcutIntent: intent },
          }),
        )
        .then((failure) => {
          if (failure) finish?.(intent.id, intent.sequence, false);
        })
        .catch(() => {
          finish?.(intent.id, intent.sequence, false);
        });
    });

    const openedAppShortcuts = [];
    const pendingColdIntents = [];
    let settingsMounted = false;

    const deliverIntentToSettingsChild = (appTarget) => {
      nextSequence += 1;
      const packet = {
        version: 1,
        id: nextSequence.toString(16).padStart(32, "0"),
        sessionId,
        sequence: nextSequence,
        target: { kind: "app", path: appTarget.path, name: appTarget.name },
      };
      if (!settingsMounted) {
        pendingColdIntents.push(packet);
      } else {
        assert.equal(dom.window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__(packet), true);
      }
    };

    const appCatalog = new Map([
      [sameAppA.path, { path: sameAppA.path, name: sameAppA.name }],
      [sameAppB.path, { path: sameAppB.path, name: sameAppB.name }],
    ]);
    const launchTargets = createRendererAppLaunchTargets({
      resolveApp: async (appPath) => appCatalog.get(appPath),
      getLocalShortcuts: async () => [],
      launch: async () => {
        throw new Error("should not launch app or plugin when opening shortcut settings");
      },
      openAppShortcuts: async (app) => {
        openedAppShortcuts.push(app);
        deliverIntentToSettingsChild(app);
      },
      revealApp: async () => undefined,
      revealLocal: async () => undefined,
      rejectUnsupported: async () => {
        throw new Error("unsupported");
      },
      ensureActive() {},
    });

    // Simulate patched SearchResults.vue handleContextMenuCommand executing on menu click
    const runPatchedSearchResultsMenuCommand = async (command) => {
      assert.ok(command.startsWith("add-global-shortcut:"));
      const jsonStr = command.replace("add-global-shortcut:", "");
      const { path: appPath, name, subType } = JSON.parse(jsonStr);
      if (subType !== "app" || typeof appPath !== "string" || typeof name !== "string") return;
      const targetCommand = { path: appPath, name, subType: "app" };
      await launchTargets.launch({
        path: "/setting",
        type: "plugin",
        featureCode: "ui.router?router=Shortcuts",
        name: "快捷键",
        cmdType: "text",
        param: { payload: targetCommand },
      });
    };

    // Trigger cold-start menu selection from Main for Same.app A (/Applications/Same.app)
    deliverMenuSelection(appAMenuId);
    assert.equal(receivedMenuCommands.length, 1);
    await runPatchedSearchResultsMenuCommand(receivedMenuCommands[0]);
    assert.deepEqual(openedAppShortcuts, [
      { path: "/Applications/Same.app", name: "Same", subType: "app" },
    ]);
    assert.equal(pendingColdIntents.length, 1);

    // 3. Compile and mount the real patched Settings Child components:
    //    ShortcutsSetting.vue + ShortcutEditor.vue + CommandTargetSelector.vue
    const commandSharedSource = readFileSync(
      path.join(upstreamRoot, "src/shared/commandShared.ts"),
      "utf8",
    );
    const commandSharedMod = { exports: {} };
    new Function(
      "require",
      "module",
      "exports",
      ts.transpileModule(commandSharedSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    )(
      (id) => {
        if (id === "./storageKeys") {
          return { HOST_STORAGE_KEYS: { commandAliases: "command-aliases" } };
        }
        throw new Error(`Unexpected import in commandShared: ${id}`);
      },
      commandSharedMod,
      commandSharedMod.exports,
    );

    const shortcutsSettingTsSource = readFileSync(
      path.join(
        upstreamRoot,
        "internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.ts",
      ),
      "utf8",
    );
    const shortcutsSettingTsMod = { exports: {} };
    new Function(
      "require",
      "module",
      "exports",
      ts.transpileModule(shortcutsSettingTsSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    )(
      (id) => {
        if (id === "@/router") return { router };
        throw new Error(`Unexpected import in ShortcutsSetting.ts: ${id}`);
      },
      shortcutsSettingTsMod,
      shortcutsSettingTsMod.exports,
    );

    const AdaptiveIcon = {
      props: ["src"],
      setup() {
        return () => vue.h("span", { class: "adaptive-icon-stub" });
      },
    };
    const DetailPanel = {
      props: ["title"],
      emits: ["back"],
      setup(props, { slots, emit }) {
        return () =>
          vue.h("div", { class: "detail-panel-stub", "data-title": props.title }, [
            vue.h(
              "button",
              { class: "detail-panel-back", onClick: () => emit("back") },
              "返回",
            ),
            slots.default?.(),
          ]);
      },
    };
    const HotkeyInput = {
      props: ["modelValue", "platform", "placeholder"],
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          vue.h("input", {
            class: "hotkey-input-stub",
            value: props.modelValue,
            placeholder: props.placeholder,
            onInput: (e) => emit("update:modelValue", e.target.value),
          });
      },
    };

    const weightedSearch = (items, query, getters) => {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return items;
      return items.filter((item) =>
        getters.some((g) => String(g.value(item) || "").toLowerCase().includes(q)),
      );
    };

    const selectorSource = applySettingsPatch(
      "internal-plugins/setting/src/views/ShortcutsSetting/components/CommandTargetSelector.vue",
    ).patched;
    const CommandTargetSelector = compileVueSfc(
      selectorSource,
      "CommandTargetSelector",
      (id) => {
        if (id === "vue") return vue;
        if (id === "@/components") return { AdaptiveIcon };
        if (id === "@/utils") return { weightedSearch };
        if (id === "@/views/ShortcutsSetting/ShortcutsSetting") return shortcutsSettingTsMod.exports;
        throw new Error(`Unexpected import in CommandTargetSelector: ${id}`);
      },
    );

    const toasts = { success: [], error: [], warning: [] };
    const useToast = () => ({
      success: (msg) => toasts.success.push(msg),
      error: (msg) => toasts.error.push(msg),
      warning: (msg) => toasts.warning.push(msg),
      confirm: async () => true,
    });

    const editorSource = applySettingsPatch(
      "internal-plugins/setting/src/components/common/ShortcutEditor/ShortcutEditor.vue",
    ).patched;
    const ShortcutEditor = compileVueSfc(editorSource, "ShortcutEditor", (id) => {
      if (id === "vue") return vue;
      if (id === "@/components/common/Toast") return { useToast };
      if (id === "@/components") return { HotkeyInput, DetailPanel };
      if (id.endsWith("/CommandTargetSelector.vue")) return { default: CommandTargetSelector };
      if (id === "@/views/ShortcutsSetting/ShortcutsSetting") return shortcutsSettingTsMod.exports;
      throw new Error(`Unexpected import in ShortcutEditor: ${id}`);
    });

    const shortcutsSettingSource = applySettingsPatch(
      "internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue",
    ).patched;
    const ShortcutsSetting = compileVueSfc(
      shortcutsSettingSource,
      "ShortcutsSetting",
      (id) => {
        if (id === "vue") return vue;
        if (id === "@/components") return { useToast, ShortcutEditor, AdaptiveIcon };
        if (id === "@/utils") return { weightedSearch };
        if (id === "@/composables") {
          return {
            useJumpFunction: (cb) => {
              jumpListeners.push(cb);
            },
            useZtoolsSubInput: (initial = "") => ({ value: vue.ref(initial) }),
          };
        }
        if (id === "@/views/ShortcutsSetting/ShortcutsSetting") return shortcutsSettingTsMod.exports;
        if (id === "@shared/commandShared") return commandSharedMod.exports;
        if (id === "./components/AliasMappingDialog.vue") {
          return { default: { render: () => null } };
        }
        throw new Error(`Unexpected import in ShortcutsSetting: ${id}`);
      },
    );

    // Set up window.ztools.internal backed by createAppGlobalShortcutsController
    let currentRevision = "1".repeat(32);
    let currentSnapshot = {
      version: 1,
      revision: currentRevision,
      rows: [],
      bindings: [],
      runtime: [],
    };
    const backendCalls = [];
    const controller = createAppGlobalShortcutsController({
      isLive: () => true,
      invoke: async (operation, payload) => {
        backendCalls.push({ operation, payload });
        if (operation === "readAppGlobalShortcuts") {
          return currentSnapshot;
        }
        if (operation === "mutateAppGlobalShortcut") {
          assert.equal(payload.revision, currentRevision);
          const { mutation } = payload;
          currentRevision = currentRevision === "1".repeat(32) ? "2".repeat(32) : "3".repeat(32);
          const rowId = mutation.rowId || `row-${currentSnapshot.rows.length + 1}`;
          const nextRow = {
            id: rowId,
            shortcut: mutation.shortcut,
            target: mutation.target.name,
            enabled: mutation.enabled,
            autoCopy: false,
          };
          const nextBinding = {
            rowId,
            shortcut: mutation.shortcut,
            enabled: mutation.enabled,
            target: mutation.target,
          };
          currentSnapshot = {
            version: 1,
            revision: currentRevision,
            rows:
              mutation.kind === "create"
                ? [...currentSnapshot.rows, nextRow]
                : currentSnapshot.rows.map((r) => (r.id === rowId ? nextRow : r)),
            bindings:
              mutation.kind === "create"
                ? [...currentSnapshot.bindings, nextBinding]
                : currentSnapshot.bindings.map((b) => (b.rowId === rowId ? nextBinding : b)),
            runtime:
              mutation.kind === "create"
                ? [
                    ...currentSnapshot.runtime,
                    {
                      rowId,
                      state: "registered",
                      error: null,
                    },
                  ]
                : currentSnapshot.runtime,
          };
          return {
            version: 1,
            persisted: true,
            changed: true,
            runtimeApplied: true,
            notificationDelivered: true,
            error: null,
            snapshot: currentSnapshot,
          };
        }
        throw new Error(`Unexpected operation: ${operation}`);
      },
    });

    let stopRecordingCalls = 0;
    dom.window.ztools = {
      internal: {
        getPlatform: () => "darwin",
        readAppGlobalShortcuts: () => controller.read(),
        mutateAppGlobalShortcut: (mutation) => controller.mutate(mutation),
        stopHotkeyRecording: async () => {
          stopRecordingCalls += 1;
        },
        dbGet: async () => null,
        dbPut: async () => {
          throw new Error("legacy dbPut must not be called for global shortcuts");
        },
        getCommands: async () => ({
          commands: [sameAppA, sameAppB, localShortcutItem],
          regexCommands: [],
          plugins: [],
        }),
      },
    };

    const mountEl = dom.window.document.getElementById("app");
    const vueApp = vue.createApp(ShortcutsSetting);
    vueApp.mount(mountEl);
    settingsMounted = true;

    // Deliver the cold-start queued intent now that the newly opened Settings Child is ready,
    // and let initial loadShortcuts() complete.
    for (const packet of pendingColdIntents.splice(0)) {
      assert.equal(dom.window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__(packet), true);
    }
    await flushVue(10);

    // Verify cold-start prefill selected Same.app A (/Applications/Same.app) and ACKed sequence 1
    const getSelectedSubtitle = () =>
      mountEl.querySelector(
        ".editor-wrapper .target-card:not(.target-card-empty) .target-card-subtitle",
      )?.textContent;
    const getSelectedTitle = () =>
      mountEl.querySelector(
        ".editor-wrapper .target-card:not(.target-card-empty) .target-card-title",
      )?.textContent;

    assert.equal(getSelectedTitle(), "系统应用 / Same");
    assert.equal(getSelectedSubtitle(), "/Applications/Same.app");
    assert.deepEqual(ackCalls, [
      {
        id: (1).toString(16).padStart(32, "0"),
        sequence: 1,
        accepted: true,
      },
    ]);

    // 4. Warm-session prefill: Settings Child is already open when user triggers "设置全局快捷键"
    //    on the second same-named app (/Users/harris/Applications/Same.app) in Main!
    await contextMenu.showContextMenu(buildMoreMenuFor(sameAppB));
    const appBMenuId = shownMenus.at(-1)[0].submenu[0].id;
    assert.notEqual(appBMenuId, appAMenuId);
    deliverMenuSelection(appBMenuId);
    assert.equal(receivedMenuCommands.length, 2);
    await runPatchedSearchResultsMenuCommand(receivedMenuCommands[1]);
    await flushVue(10);

    // Verify warm Settings Child updated prefill in-place to Same.app B and ACKed sequence 2!
    assert.equal(getSelectedTitle(), "系统应用 / Same");
    assert.equal(getSelectedSubtitle(), "/Users/harris/Applications/Same.app");
    assert.deepEqual(ackCalls, [
      {
        id: (1).toString(16).padStart(32, "0"),
        sequence: 1,
        accepted: true,
      },
      {
        id: (2).toString(16).padStart(32, "0"),
        sequence: 2,
        accepted: true,
      },
    ]);

    // 5. Actual App selection & same-name disambiguation inside CommandTargetSelector.vue
    const groupButtons = Array.from(mountEl.querySelectorAll(".plugin-selector-item"));
    assert.equal(groupButtons.length, 1);
    assert.ok(groupButtons[0].textContent.includes("系统应用"));
    assert.ok(groupButtons[0].textContent.includes("2 个指令"));
    groupButtons[0].click();
    await flushVue(4);

    const commandItems = Array.from(mountEl.querySelectorAll(".command-selector-item"));
    assert.equal(commandItems.length, 2);
    const renderedTargets = commandItems.map((btn) => ({
      title: btn.querySelector(".selector-item-title")?.textContent?.trim(),
      subtitle: btn.querySelector(".selector-item-subtitle")?.textContent?.trim(),
      active: btn.classList.contains("active"),
    }));
    assert.deepEqual(renderedTargets, [
      {
        title: "Same",
        subtitle: "/Applications/Same.app",
        active: false,
      },
      {
        title: "Same",
        subtitle: "/Users/harris/Applications/Same.app",
        active: true,
      },
    ]);

    // Click the first same-named app (/Applications/Same.app) in the selector to switch selection
    commandItems[0].click();
    await flushVue(4);
    assert.equal(getSelectedSubtitle(), "/Applications/Same.app");
    assert.equal(commandItems[0].classList.contains("active"), true);
    assert.equal(commandItems[1].classList.contains("active"), false);

    // Switch back to the second same-named app (/Users/harris/Applications/Same.app) and save
    commandItems[1].click();
    await flushVue(4);
    assert.equal(getSelectedSubtitle(), "/Users/harris/Applications/Same.app");

    const hotkeyInput = mountEl.querySelector(".hotkey-input-stub");
    assert.ok(hotkeyInput);
    hotkeyInput.value = "Option+S";
    hotkeyInput.dispatchEvent(new dom.window.Event("input"));
    await flushVue(4);

    const saveButton = Array.from(mountEl.querySelectorAll(".editor-footer .btn")).find(
      (btn) => btn.textContent?.trim() === "确定",
    );
    assert.ok(saveButton);
    assert.equal(saveButton.disabled, false);
    saveButton.click();
    await flushVue(10);

    assert.equal(stopRecordingCalls, 1);
    assert.equal(backendCalls.length, 2);
    assert.deepEqual(backendCalls[1], {
      operation: "mutateAppGlobalShortcut",
      payload: {
        revision: "1".repeat(32),
        mutation: {
          kind: "create",
          shortcut: "Option+S",
          target: {
            kind: "app",
            path: "/Users/harris/Applications/Same.app",
            name: "Same",
          },
          enabled: true,
          autoCopy: false,
        },
      },
    });
    assert.deepEqual(toasts.success, ["快捷键添加成功!"]);

    // 6. Verify editing the saved row preserves exact appTarget authority (/Users/harris/Applications/Same.app)
    //    even though two apps share the name "Same", and switching to /Applications/Same.app sends an update mutation.
    const editButtons = Array.from(mountEl.querySelectorAll(".shortcut-list .icon-btn")).filter(
      (btn) => btn.getAttribute("title") === "编辑",
    );
    assert.equal(editButtons.length, 1);
    editButtons[0].click();
    await flushVue(6);
    assert.equal(getSelectedTitle(), "系统应用 / Same");
    assert.equal(getSelectedSubtitle(), "/Users/harris/Applications/Same.app");

    const editGroupButtons = Array.from(mountEl.querySelectorAll(".plugin-selector-item"));
    editGroupButtons[0].click();
    await flushVue(4);
    const editCommandItems = Array.from(mountEl.querySelectorAll(".command-selector-item"));
    assert.equal(editCommandItems.length, 2);
    editCommandItems[0].click();
    await flushVue(4);
    assert.equal(getSelectedSubtitle(), "/Applications/Same.app");

    const editSaveButton = Array.from(mountEl.querySelectorAll(".editor-footer .btn")).find(
      (btn) => btn.textContent?.trim() === "确定",
    );
    assert.ok(editSaveButton);
    assert.equal(editSaveButton.disabled, false);
    editSaveButton.click();
    await flushVue(10);

    assert.equal(stopRecordingCalls, 2);
    assert.equal(backendCalls.length, 3);
    assert.deepEqual(backendCalls[2], {
      operation: "mutateAppGlobalShortcut",
      payload: {
        revision: "2".repeat(32),
        mutation: {
          kind: "update",
          rowId: "row-1",
          shortcut: "Option+S",
          target: {
            kind: "app",
            path: "/Applications/Same.app",
            name: "Same",
          },
          enabled: true,
          autoCopy: false,
        },
      },
    });
    assert.deepEqual(toasts.success, ["快捷键添加成功!", "快捷键更新成功!"]);

    vueApp.unmount();
    stopReceiver();
    contextMenu.dispose();
  } finally {
    dom.window.document.body.innerHTML = "";
  }
});
