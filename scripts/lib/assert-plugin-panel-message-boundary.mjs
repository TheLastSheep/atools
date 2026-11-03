import assert from "node:assert/strict";
import { loadProductionPluginBridgeTemplate, readPanelHostSource } from "./plugin-panel-source-test-adapter.mjs";

/** Static checks follow the extracted production owners used by the real panel. */
export async function assertPluginPanelMessageBoundary(root) {
  const owners = Object.fromEntries(await Promise.all([
    ["component", "src/components/PluginPanel.svelte"],
    ["frameMount", "src/lib/pluginPanelFrameMount.ts"],
    ["messageHost", "src/lib/pluginPanelMessageHost.ts"],
    ["messageRouter", "src/lib/pluginPanelMessageRouter.ts"],
    ["authenticated", "src/lib/authenticatedPluginMessageHandler.ts"],
    ["nativeRouter", "src/lib/pluginPanelNativeBridgeRouter.ts"],
    ["permissionController", "src/lib/pluginPanelPermissionController.ts"],
  ].map(async ([name, path]) => [name, await readPanelHostSource(root, path)])));
  const bridgeSource = await loadProductionPluginBridgeTemplate(root);

  assert.doesNotMatch(
    bridgeSource,
    /__TAURI_INTERNALS__/,
    "sandboxed plugin code must never discover window, parent, or top Tauri internals",
  );
  assert.match(owners.component, /createPluginPanelMessageHost\(/, "PluginPanel must instantiate the production message host");
  assert.match(
    owners.component,
    /<svelte:window\s+onmessage=\{pluginPanelMessageHost\.handleMessage\}/,
    "window messages must enter through the production message-host handler",
  );

  const mountMain = owners.frameMount.indexOf("ports.registerFrame({ kind: \"main\" }, node.contentWindow");
  const mountChild = owners.frameMount.indexOf("ports.registerChild(currentWindowId, node.contentWindow");
  const bindChild = owners.frameMount.indexOf("ports.bind({ kind: \"child\", windowId: currentWindowId }, node.contentWindow");
  assert.ok(mountMain >= 0, "the main iframe WindowProxy must be registered by its frame-mount owner");
  assert.ok(mountChild >= 0 && bindChild > mountChild, "hosted child WindowProxy identity must be registered and bound by FrameMount");

  const nativeComposition = owners.messageHost.indexOf("const nativeBridge = createPluginNativeBridgeRouter(");
  const authenticatedComposition = owners.messageHost.indexOf("const authenticated = createAuthenticatedPluginMessageHandler(");
  const routerComposition = owners.messageHost.indexOf("const router = createPluginPanelMessageRouter(");
  assert.ok(nativeComposition >= 0 && authenticatedComposition > nativeComposition && routerComposition > authenticatedComposition,
    "MessageHost must compose NativeBridgeRouter, AuthenticatedPluginMessageHandler, then MessageRouter");
  assert.match(owners.messageHost, /handleNativeCall:\s*nativeBridge\.handleNativeBridgeCall/);
  assert.match(owners.messageHost, /dispatchInvoke:\s*dispatchPluginInvokeMessage/);
  assert.match(owners.messageHost, /postIfCurrent:\s*postPluginFrameMessageIfCurrent/);
  assert.match(owners.messageHost, /identify:\s*event\s*=>\s*identifyPluginMessageEvent\(ports\.sources,\s*event\)/);

  const identifyIndex = owners.messageRouter.indexOf("const identity = context.identify(event)");
  const rejectUnknownIndex = owners.messageRouter.indexOf("if (!identity) return", identifyIndex);
  const permissionIndex = owners.messageRouter.indexOf("context.dispatchPermissions(event, data, identity)");
  const authenticatedIndex = owners.messageRouter.indexOf("context.dispatchAuthenticated(event, data, identity)");
  assert.ok(identifyIndex >= 0 && rejectUnknownIndex > identifyIndex && permissionIndex > rejectUnknownIndex
    && authenticatedIndex > permissionIndex,
  "MessageRouter must identify the source and reject unknown frames before permission or authenticated dispatch");

  const invokeStart = owners.authenticated.indexOf("if (data.__ipc_call__)");
  const mainOnlyStart = owners.authenticated.indexOf('if (sourceIdentity.kind !== "main")', invokeStart);
  assert.ok(invokeStart >= 0 && mainOnlyStart > invokeStart, "authenticated invoke dispatch must precede main-frame-only UI handling");
  assert.match(owners.authenticated, /if \(sourceIdentity\.kind !== "main"\) return;/,
    "hosted children must be rejected before main-frame-only UI handling");
  const invokeSource = owners.authenticated.slice(invokeStart, mainOnlyStart);
  assert.match(invokeSource, /ports\.dispatchInvoke\(/);
  assert.ok((invokeSource.match(/ports\.postIfCurrent\(/g) || []).length >= 2,
    "invoke success and error responses must both use generation-gated delivery");

  const nativeStart = owners.nativeRouter.indexOf("async function handleNativeBridgeCall(");
  const nativeEnd = owners.nativeRouter.indexOf("return { handleNativeBridgeCall }", nativeStart);
  assert.ok(nativeStart >= 0 && nativeEnd > nativeStart, "NativeBridgeRouter must own its call handler");
  const nativeHandlerSource = owners.nativeRouter.slice(nativeStart, nativeEnd);
  assert.match(nativeHandlerSource, /runPluginFrameOperation/, "native calls must revalidate around execution");
  assert.ok((nativeHandlerSource.match(/postPluginFrameMessageIfCurrent\(/g) || []).length >= 2,
    "native success and error responses must both use generation-gated delivery");

  assert.match(owners.nativeRouter, /bindNativeBridgeArgsToSource/,
    "native bridge arguments must be bound to the identified frame before dispatch");
  assert.match(owners.permissionController, /pluginPermissionListAllows\(ports\.action\(\)\.plugin_permissions, value\)/,
    "host permission checks must include the active manifest policy");
  assert.match(owners.permissionController, /if \(!value\) throw new Error\("Unsupported plugin permission"\)/,
    "unknown permissions must fail closed before the approval queue");
  assert.match(owners.component, /ensure:\s*ensureHostPluginPermission/,
    "the panel must bind the production permission controller's ensure function");
  return { ...owners, bridgeSource, invokeSource, nativeHandlerSource };
}
