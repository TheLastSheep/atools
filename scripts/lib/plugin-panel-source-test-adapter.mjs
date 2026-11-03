import { readFile } from "node:fs/promises";
import { createSourceFile, forEachChild, isCallExpression, isExportDeclaration, isImportDeclaration, ModuleKind, ScriptKind, ScriptTarget, SyntaxKind, transpileModule } from "typescript";
import { injectPluginBridgeFactories } from "./plugin-bridge-fixture.mjs";

const panelOwnerSources = [
  "src/components/PluginBrowserWindowLayer.svelte", "src/components/PluginPanel.css",
  "src/components/PluginPanel.svelte", "src/components/PluginPanelBody.svelte", "src/components/PluginPanelChrome.svelte",
  "src/lib/authenticatedPluginMessageHandler.ts", "src/lib/pluginBrowserWindowActionDispatcher.ts",
  "src/lib/pluginBrowserWindowActionPorts.ts", "src/lib/pluginBrowserWindowCreateController.ts",
  "src/lib/pluginBrowserWindowFrameCommands.ts", "src/lib/pluginBrowserWindowGeometryActions.ts",
  "src/lib/pluginBrowserWindowLifecycleActions.ts", "src/lib/pluginBrowserWindowNavigationLoader.ts",
  "src/lib/pluginBrowserWindowPresentation.ts", "src/lib/pluginBrowserWindowState.ts", "src/lib/pluginBrowserWindowTypes.ts",
  "src/lib/pluginBrowserWindowWebContentsController.ts", "src/lib/pluginDesktopSmokeBridgeSource.ts",
  "src/lib/pluginPanelActiveResources.ts", "src/lib/pluginPanelBridgeCompiler.ts", "src/lib/pluginPanelBrowserWindowRuntime.ts",
  "src/lib/pluginPanelBrowserWindowState.svelte.ts", "src/lib/pluginPanelCapabilityReopen.ts",
  "src/lib/pluginPanelContextMenu.svelte.ts", "src/lib/pluginPanelContracts.ts", "src/lib/pluginPanelDesktopSmokeState.ts",
  "src/lib/pluginPanelDocumentSourceHost.ts", "src/lib/pluginPanelFrameFocus.ts", "src/lib/pluginPanelFrameMount.ts",
  "src/lib/pluginPanelInteractions.ts", "src/lib/pluginPanelLoadController.ts", "src/lib/pluginPanelMessageHandlers.ts",
  "src/lib/pluginPanelMessageHost.ts", "src/lib/pluginPanelMessageRouter.ts", "src/lib/pluginPanelNativeBridgeRouter.ts",
  "src/lib/pluginPanelPermissionController.ts", "src/lib/pluginPanelRenderSmokeController.ts",
  "src/lib/pluginPanelSessionLifecycle.ts", "src/lib/pluginPanelSystemClipboard.ts",
];
const launcherOwnerSources = [
  "src/lib/desktopSmokeOrchestration.ts",
  "src/lib/launcherPluginSessionController.ts",
  "src/lib/launcherPluginWindowController.ts",
  "src/lib/launcherWindowRuntimeHost.ts",
  "src/lib/pluginHostSmokeAction.ts",
  "src/lib/pluginRedirect.ts",
];
const bridgeOwnerSources = [
  "src/lib/pluginUtoolsBridgeSource/attachments-and-db-storage.ts",
  "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts",
  "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts",
  "src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts",
  "src/lib/pluginUtoolsBridgeSource/frame-permissions.ts",
  "src/lib/pluginUtoolsBridgeSource/native-call-and-node-shims.ts",
  "src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts",
  "src/lib/pluginUtoolsBridgeSource/runtime-resource-dom-installation.ts",
  "src/lib/pluginUtoolsBridgeSource/runtime-resource-url-and-css-rewrite.ts",
  "src/lib/pluginUtoolsBridgeSource/utools-api-and-dynamic-features.ts",
  "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts",
  "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts",
];

function moduleReferences(source, fileName) {
  const parsed = createSourceFile(fileName, source, ScriptTarget.ESNext, true, ScriptKind.JS);
  if (parsed.parseDiagnostics.length > 0) throw new Error("Production bridge module could not be parsed");
  const references = [];
  let hasDynamicImport = false;
  const visit = node => {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && specifier.kind === SyntaxKind.StringLiteral) {
        references.push({ specifier: specifier.text, start: specifier.getStart(parsed), end: specifier.getEnd() });
      }
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      hasDynamicImport = true;
    }
    forEachChild(node, visit);
  };
  visit(parsed);
  return { references, hasDynamicImport };
}

async function productionBridgeSourceUrl(root) {
  const entryUrl = new URL("src/lib/pluginUtoolsBridgeSource.ts", root);
  const entryText = await readFile(entryUrl, "utf8");
  const entryModule = transpileModule(entryText, {
    fileName: entryUrl.pathname,
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
  }).outputText;
  const { references, hasDynamicImport } = moduleReferences(entryModule, entryUrl.pathname);
  if (references.length === 0 || hasDynamicImport) throw new Error("Production bridge source composition imports changed");

  const replacements = [];
  for (const reference of references) {
    if (!reference.specifier.startsWith(".")) throw new Error("Production bridge source has an unbound module dependency");
    const dependencyUrl = new URL(reference.specifier, entryUrl);
    if (!dependencyUrl.pathname.endsWith(".ts")) dependencyUrl.pathname += ".ts";
    const dependencyText = await readFile(dependencyUrl, "utf8");
    const dependencyModule = transpileModule(dependencyText, {
      fileName: dependencyUrl.pathname,
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
    }).outputText;
    const dependencyGraph = moduleReferences(dependencyModule, dependencyUrl.pathname);
    if (dependencyGraph.references.length > 0 || dependencyGraph.hasDynamicImport) {
      throw new Error("Production bridge leaf module acquired an unbound dependency");
    }
    const dependencyDataUrl = "data:text/javascript;base64," + Buffer.from(dependencyModule).toString("base64");
    replacements.push({ ...reference, replacement: JSON.stringify(dependencyDataUrl) });
  }

  let boundEntryModule = entryModule;
  for (const reference of replacements.sort((left, right) => right.start - left.start)) {
    boundEntryModule = boundEntryModule.slice(0, reference.start) + reference.replacement + boundEntryModule.slice(reference.end);
  }
  return "data:text/javascript;base64," + Buffer.from(boundEntryModule).toString("base64");
}

/** Read one named launcher owner; callers cannot scan or concatenate arbitrary src files. */
export async function readLauncherOwnerSource(root, relativePath) {
  if (!launcherOwnerSources.includes(relativePath)) {
    throw new Error(`Launcher source is not a registered owner: ${relativePath}`);
  }
  return readFile(new URL(relativePath, root), "utf8");
}

/** Read actual extracted host owners for static source assertions, never for VM execution. */
export async function readPanelHostImplementationSource(root) {
  const sources = await Promise.all(panelOwnerSources.map(async path =>
    `${path}\n${await readFile(new URL(path, root), "utf8")}`));
  return sources.join("\n");
}

/** Read one named production owner when an assertion concerns a specific extracted responsibility. */
export async function readPanelHostSource(root, relativePath) {
  if (!panelOwnerSources.includes(relativePath) && !bridgeOwnerSources.includes(relativePath)) {
    throw new Error(`PluginPanel source is not a registered owner: ${relativePath}`);
  }
  return readFile(new URL(relativePath, root), "utf8");
}


/** Read a caller-selected set of named owners for a cross-module contract. */
export async function readPanelHostSources(root, relativePaths) {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    throw new Error("PluginPanel source owner set must be non-empty");
  }
  const uniquePaths = [...new Set(relativePaths)];
  if (uniquePaths.length !== relativePaths.length) {
    throw new Error("PluginPanel source owner set must not contain duplicates");
  }
  return (await Promise.all(uniquePaths.map(async path => {
    if (!panelOwnerSources.includes(path) && !bridgeOwnerSources.includes(path)) {
      throw new Error(`PluginPanel source is not a registered owner: ${path}`);
    }
    return `${path}\n${await readFile(new URL(path, root), "utf8")}`;
  }))).join("\n");
}

/** Load the real exported UTOOLS_BRIDGE module graph before installing production factories for VM tests. */
export async function loadProductionPluginBridgeTemplate(root) {
  const moduleUrl = await productionBridgeSourceUrl(root);
  const loaded = await import(moduleUrl);
  if (typeof loaded.UTOOLS_BRIDGE !== "string") throw new Error("Production UTOOLS_BRIDGE export is unavailable");
  return injectPluginBridgeFactories(loaded.UTOOLS_BRIDGE);
}
