import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected uTools bridge");
assert.doesNotMatch(
  bridgeMatch[1],
  /__TAURI_INTERNALS__/,
  "sandboxed plugin code must never discover window, parent, or top Tauri internals",
);

const handleMessageStart = componentSource.indexOf("function handleMessage(e: MessageEvent)");
const handleMessageEnd = componentSource.indexOf("\n  }\n</script>", handleMessageStart);
assert.ok(handleMessageStart >= 0 && handleMessageEnd > handleMessageStart, "PluginPanel should keep one host message handler");
const handleMessageSource = componentSource.slice(handleMessageStart, handleMessageEnd);
const sourceGateIndex = handleMessageSource.indexOf("identifyPluginMessageEvent(pluginMessageSources, e)");
const firstDispatchIndex = handleMessageSource.indexOf("data.__atools_permission_request__");
assert.ok(
  sourceGateIndex >= 0 && sourceGateIndex < firstDispatchIndex,
  "the WindowProxy identity gate must run before any plugin message dispatch",
);
assert.match(
  handleMessageSource,
  /if \(sourceIdentity\.kind !== "main"\) return;/,
  "main-frame-only output, probe, and UI messages must be blocked for hosted children",
);
assert.match(componentSource, /use:pluginMainFrame/, "the main iframe must register its WindowProxy");
assert.match(componentSource, /registerChild\(/, "hosted child iframes must register their WindowProxy");
assert.match(
  componentSource,
  /bindNativeBridgeArgsToSource/,
  "native bridge calls must bind source-owned identity before dispatch",
);
assert.match(componentSource, /window\.atools = \{\s*pasteboard:/, "ATools plugins should receive the narrow PasteboardPro bridge");
assert.match(
  componentSource,
  /pluginPermissionListAllows\(action\.plugin_permissions, value\)/,
  "host permission checks must use the fail-closed manifest permission policy",
);

const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-invoke-policy-"));
const outFile = join(outDir, "pluginInvokePolicy.mjs");

try {
  const sourcePath = new URL("src/lib/pluginInvokePolicy.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);
  const policy = await import(pathToFileURL(outFile).href);

  const mainSource = {};
  const childSource = {};
  const foreignSource = {};
  const sources = new policy.PluginFrameSourceRegistry();
  sources.setMain(mainSource);
  sources.registerChild("child-1", childSource);

  const initialMainIdentity = sources.identify(mainSource);
  const initialChildIdentity = sources.identify(childSource);
  assert.equal(initialMainIdentity?.kind, "main");
  assert.equal(initialChildIdentity?.kind, "child");
  assert.equal(initialChildIdentity?.windowId, "child-1");
  assert.ok(Number.isSafeInteger(initialMainIdentity?.generation), "main identity should carry a safe generation");
  assert.ok(Number.isSafeInteger(initialChildIdentity?.generation), "child identity should carry a safe generation");
  assert.notEqual(initialMainIdentity.generation, initialChildIdentity.generation);
  assert.equal(sources.identify(foreignSource), null);
  assert.equal(sources.identify(null), null);

  sources.setMain(mainSource);
  const reloadedMainIdentity = sources.identify(mainSource);
  assert.notEqual(
    reloadedMainIdentity.generation,
    initialMainIdentity.generation,
    "registering the same main WindowProxy after navigation must advance its generation",
  );
  assert.equal(
    sources.isCurrent(mainSource, initialMainIdentity),
    false,
    "a pre-navigation main identity must not become current again for the same WindowProxy",
  );

  sources.registerChild("child-1", childSource);
  const reloadedChildIdentity = sources.identify(childSource);
  assert.notEqual(
    reloadedChildIdentity.generation,
    initialChildIdentity.generation,
    "registering the same child WindowProxy after navigation must advance its generation",
  );
  assert.equal(
    sources.isCurrent(childSource, initialChildIdentity),
    false,
    "a pre-navigation child identity must not become current again for the same WindowProxy",
  );

  const preClearMainIdentity = reloadedMainIdentity;
  const preClearChildIdentity = reloadedChildIdentity;
  sources.clear();
  sources.setMain(mainSource);
  sources.registerChild("child-1", childSource);
  assert.equal(
    sources.isCurrent(mainSource, preClearMainIdentity),
    false,
    "clear plus same-source re-registration must not revive an old main identity",
  );
  assert.equal(
    sources.isCurrent(childSource, preClearChildIdentity),
    false,
    "clear plus same-source re-registration must not revive an old child identity",
  );

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  const invokeCalls = [];
  const permissionCalls = [];
  const dispatch = (source, message) => policy.dispatchPluginInvokeMessage({
    source,
    message,
    sources,
    pluginId: "trusted-plugin",
    authorize: async (permission) => {
      permissionCalls.push(permission);
    },
    invoke: async (command, args) => {
      invokeCalls.push({ command, args });
      return { ok: true };
    },
  });

  assert.deepEqual(await dispatch(foreignSource, {
    __ipc_call__: true,
    reqId: 1,
    cmd: "set_setting",
    args: { key: "secret", value: "stolen" },
  }), { handled: false }, "foreign WindowProxy messages must be ignored");
  assert.deepEqual(await dispatch(null, {
    __ipc_call__: true,
    reqId: 1,
    cmd: "set_setting",
    args: { key: "secret", value: "stolen" },
  }), { handled: false }, "null-source messages must be ignored");
  assert.equal(invokeCalls.length, 0, "untrusted sources must never invoke a Tauri command");
  assert.equal(permissionCalls.length, 0, "untrusted sources must not open a permission prompt");

  const sameSourceApprovalGate = deferred();
  let sameSourceApprovalInvokeCount = 0;
  const sameSourceApprovalDispatch = policy.dispatchPluginInvokeMessage({
    source: mainSource,
    message: { __ipc_call__: true, reqId: 8, cmd: "get_plugin_data", args: {} },
    sources,
    pluginId: "trusted-plugin",
    authorize: () => sameSourceApprovalGate.promise,
    invoke: async () => {
      sameSourceApprovalInvokeCount += 1;
      return null;
    },
  });
  await Promise.resolve();
  sources.setMain(mainSource);
  sameSourceApprovalGate.resolve();
  await assert.rejects(
    sameSourceApprovalDispatch,
    /source is no longer active/,
    "same-WindowProxy navigation during authorization must invalidate the old request generation",
  );
  assert.equal(sameSourceApprovalInvokeCount, 0, "stale-generation requests must not invoke after approval");

  let approvePausedRequest;
  const pausedPermission = new Promise((resolve) => {
    approvePausedRequest = resolve;
  });
  let pausedInvokeCount = 0;
  const pausedDispatch = policy.dispatchPluginInvokeMessage({
    source: childSource,
    message: { __ipc_call__: true, reqId: 9, cmd: "get_plugin_data", args: {} },
    sources,
    pluginId: "trusted-plugin",
    authorize: () => pausedPermission,
    invoke: async () => {
      pausedInvokeCount += 1;
      return null;
    },
  });
  await Promise.resolve();
  sources.unregisterChild("child-1", childSource);
  approvePausedRequest();
  await assert.rejects(
    pausedDispatch,
    /source is no longer active/,
    "a child closed during a permission prompt must be revalidated before invoke",
  );
  assert.equal(pausedInvokeCount, 0, "revoked child sources must not invoke after delayed approval");
  sources.registerChild("child-1", childSource);

  const invokeStarted = deferred();
  const invokeResultGate = deferred();
  const inFlightInvokeDispatch = policy.dispatchPluginInvokeMessage({
    source: mainSource,
    message: { __ipc_call__: true, reqId: 10, cmd: "get_plugin_data", args: {} },
    sources,
    pluginId: "trusted-plugin",
    authorize: async () => {},
    invoke: async () => {
      invokeStarted.resolve();
      return invokeResultGate.promise;
    },
  });
  await invokeStarted.promise;
  sources.setMain(mainSource);
  invokeResultGate.resolve({ secret: "old-document" });
  await assert.rejects(
    inFlightInvokeDispatch,
    /source is no longer active/,
    "invoke results from a pre-navigation generation must be discarded",
  );

  const nativeStarted = deferred();
  const nativeResultGate = deferred();
  const nativeIdentity = sources.identify(childSource);
  const inFlightNativeOperation = policy.runPluginFrameOperation({
    source: childSource,
    identity: nativeIdentity,
    sources,
    operation: async () => {
      nativeStarted.resolve();
      return nativeResultGate.promise;
    },
  });
  await nativeStarted.promise;
  sources.registerChild("child-1", childSource);
  nativeResultGate.resolve({ secret: "old-native-result" });
  await assert.rejects(
    inFlightNativeOperation,
    /source is no longer active/,
    "native results from a pre-navigation child generation must be discarded",
  );

  const deliveredMessages = [];
  const deliverySource = {
    postMessage(message, targetOrigin) {
      deliveredMessages.push({ message, targetOrigin });
    },
  };
  sources.setMain(deliverySource);
  const staleDeliveryIdentity = sources.identify(deliverySource);
  sources.setMain(deliverySource);
  assert.equal(
    policy.postPluginFrameMessageIfCurrent({
      sources,
      source: deliverySource,
      identity: staleDeliveryIdentity,
      message: { secret: "stale-result" },
    }),
    false,
    "stale-generation results must not be posted to a reused WindowProxy",
  );
  assert.deepEqual(deliveredMessages, [], "stale results and errors must not leak into the next document");
  const currentDeliveryIdentity = sources.identify(deliverySource);
  assert.equal(
    policy.postPluginFrameMessageIfCurrent({
      sources,
      source: deliverySource,
      identity: currentDeliveryIdentity,
      message: { ok: true },
    }),
    true,
  );
  assert.deepEqual(deliveredMessages, [{ message: { ok: true }, targetOrigin: "*" }]);
  sources.unregisterMain(deliverySource);
  sources.setMain(mainSource);

  const nativeHandlerStart = componentSource.indexOf("async function handleNativeBridgeCall(");
  const nativeHandlerEnd = componentSource.indexOf("\n  function handleRuntimeResourceResolveCall", nativeHandlerStart);
  const nativeHandlerSource = componentSource.slice(nativeHandlerStart, nativeHandlerEnd);
  assert.match(nativeHandlerSource, /runPluginFrameOperation/, "native calls must revalidate around execution");
  assert.ok(
    (nativeHandlerSource.match(/postPluginFrameMessageIfCurrent/g) || []).length >= 2,
    "native success and error responses must both use generation-gated delivery",
  );
  assert.ok(
    (handleMessageSource.match(/postPluginFrameMessageIfCurrent/g) || []).length >= 2,
    "invoke success and error responses must both use generation-gated delivery",
  );

  for (const command of ["unknown", "set_setting", "process_exit", "read_text_file", "fs_read_file"]) {
    await assert.rejects(
      dispatch(mainSource, { __ipc_call__: true, reqId: 2, cmd: command, args: {} }),
      /Unsupported plugin invoke command/,
      `${command} must be denied before invoke`,
    );
  }
  assert.equal(invokeCalls.length, 0, "deny-by-default commands must not reach invoke");
  assert.equal(permissionCalls.length, 0, "deny-by-default commands must not obtain an empty permission bypass");

  for (const reqId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    await assert.rejects(
      dispatch(mainSource, { __ipc_call__: true, reqId, cmd: "get_plugin_data", args: {} }),
      /positive safe integer/,
      `invalid reqId ${String(reqId)} must be rejected`,
    );
  }
  for (const args of [null, [], "", 1, true]) {
    await assert.rejects(
      dispatch(mainSource, { __ipc_call__: true, reqId: 3, cmd: "get_plugin_data", args }),
      /args must be a plain object/,
      `invalid args ${String(args)} must be rejected`,
    );
  }
  assert.equal(invokeCalls.length, 0, "invalid request shapes must be rejected before invoke");

  const validCases = [
    {
      cmd: "get_plugin_data",
      args: { pluginId: "attacker", ignored: true },
      permission: "data",
      expected: { pluginId: "trusted-plugin" },
    },
    {
      cmd: "get_plugin_data_item",
      args: { pluginId: "attacker", docId: "doc-1", ignored: true },
      permission: "data",
      expected: { pluginId: "trusted-plugin", docId: "doc-1" },
    },
    {
      cmd: "put_plugin_data",
      args: { pluginId: "attacker", doc: { _id: "doc-1", nested: { ok: true } }, ignored: true },
      permission: "data",
      expected: { pluginId: "trusted-plugin", doc: { _id: "doc-1", nested: { ok: true } } },
    },
    {
      cmd: "put_plugin_data_bulk",
      args: { pluginId: "attacker", docs: [{ _id: "a" }, { _id: "b", count: 2 }], ignored: true },
      permission: "data",
      expected: { pluginId: "trusted-plugin", docs: [{ _id: "a" }, { _id: "b", count: 2 }] },
    },
    {
      cmd: "remove_plugin_data",
      args: { pluginId: "attacker", docId: "doc-2", ignored: true },
      permission: "data",
      expected: { pluginId: "trusted-plugin", docId: "doc-2" },
    },
    {
      cmd: "copy_text",
      args: { text: "copy me", ignored: true },
      permission: "clipboard.write",
      expected: { text: "copy me" },
    },
    {
      cmd: "show_notification",
      args: { message: "hello", ignored: true },
      permission: "notification",
      expected: { message: "hello" },
    },
    {
      cmd: "system_get_path",
      args: { name: "downloads", ignored: true },
      permission: "system.path",
      expected: { name: "downloads" },
    },
    {
      cmd: "shell_open",
      args: { url: " https://example.com/path ", ignored: true },
      permission: "shell.openExternal",
      expected: { url: "https://example.com/path" },
    },
    {
      cmd: "shell_open",
      args: { url: "mailto:hello@example.com" },
      permission: "shell.openExternal",
      expected: { url: "mailto:hello@example.com" },
    },
    {
      cmd: "shell_open",
      args: { url: "file:///tmp/example.txt" },
      permission: "shell.openPath",
      expected: { url: "file:///tmp/example.txt" },
    },
    {
      cmd: "shell_open",
      args: { url: "/tmp/example.txt" },
      permission: "shell.openPath",
      expected: { url: "/tmp/example.txt" },
    },
    {
      cmd: "pasteboard_list_items",
      args: { query: "type:text", pinboardId: null, limit: 40, ignored: true },
      permission: "pasteboard.read",
      expected: { query: "type:text", pinboardId: null, limit: 40 },
    },
    {
      cmd: "pasteboard_list_pinboards",
      args: { ignored: true },
      permission: "pasteboard.read",
      expected: {},
    },
    {
      cmd: "pasteboard_create_pinboard",
      args: { name: " Design ", color: "#6f61ea", ignored: true },
      permission: "pasteboard.write",
      expected: { name: "Design", color: "#6F61EA" },
    },
    {
      cmd: "pasteboard_rename_pinboard",
      args: { id: "board-1", name: " Work " },
      permission: "pasteboard.write",
      expected: { id: "board-1", name: "Work" },
    },
    {
      cmd: "pasteboard_update_pinboard",
      args: { id: "board-1", name: null, color: "#6f61ea" },
      permission: "pasteboard.write",
      expected: { id: "board-1", name: null, color: "#6F61EA" },
    },
    {
      cmd: "pasteboard_move_pinboard",
      args: { id: "board-2", beforeId: "board-1", afterId: null },
      permission: "pasteboard.write",
      expected: { id: "board-2", beforeId: "board-1", afterId: null },
    },
    {
      cmd: "pasteboard_delete_pinboard",
      args: { id: "board-2" },
      permission: "pasteboard.write",
      expected: { id: "board-2" },
    },
    {
      cmd: "pasteboard_assign_items",
      args: { itemIds: ["item-1", "item-2"], pinboardId: "board-1" },
      permission: "pasteboard.write",
      expected: { itemIds: ["item-1", "item-2"], pinboardId: "board-1" },
    },
    {
      cmd: "get_pasteboard_capture_status",
      args: { ignored: true },
      permission: "pasteboard.read",
      expected: {},
    },
    {
      cmd: "get_pasteboard_shelf_window_state",
      args: { ignored: true },
      permission: "pasteboard.read",
      expected: {},
    },
    {
      cmd: "start_pasteboard_shelf_drag",
      args: { ignored: true },
      permission: "pasteboard.read",
      expected: {},
    },
    {
      cmd: "hide_pasteboard_shelf",
      args: {},
      permission: "pasteboard.read",
      expected: {},
    },
    {
      cmd: "pasteboard_get_item_preview",
      args: { itemId: " item-1 ", ignored: true },
      permission: "pasteboard.read",
      expected: { itemId: "item-1" },
    },
    {
      cmd: "pasteboard_recognize_item",
      args: { itemId: " item-1 ", ignored: true },
      permission: "pasteboard.write",
      expected: { itemId: "item-1" },
    },
    {
      cmd: "pasteboard_rotate_image",
      args: { itemId: " item-1 ", quarterTurns: -1, ignored: true },
      permission: "pasteboard.write",
      expected: { itemId: "item-1", quarterTurns: -1 },
    },
    {
      cmd: "pasteboard_quick_look_item",
      args: { itemId: " item-1 ", ignored: true },
      permission: "pasteboard.read",
      expected: { itemId: "item-1" },
    },
    {
      cmd: "pasteboard_paste_item",
      args: { itemId: " item-1 ", plainText: true, ignored: true },
      permission: "pasteboard.paste",
      expected: { itemId: "item-1", plainText: true },
    },
    {
      cmd: "pasteboard_copy_item",
      args: { itemId: " item-1 ", plainText: false },
      permission: "pasteboard.write",
      expected: { itemId: "item-1", plainText: false },
    },
    {
      cmd: "set_pasteboard_capture_paused",
      args: { paused: true, ignored: true },
      permission: "pasteboard.write",
      expected: { paused: true },
    },
    {
      cmd: "pasteboard_create_text_item",
      args: { text: " Draft body ", title: " Draft title " },
      permission: "pasteboard.write",
      expected: { text: "Draft body", title: "Draft title" },
    },
    {
      cmd: "pasteboard_update_text_item",
      args: { itemId: " item-1 ", text: " Edited body ", title: null },
      permission: "pasteboard.write",
      expected: { itemId: "item-1", text: "Edited body", title: null },
    },
    {
      cmd: "pasteboard_update_item_title",
      args: { itemId: " item-1 ", title: " Final title " },
      permission: "pasteboard.write",
      expected: { itemId: "item-1", title: "Final title" },
    },
    {
      cmd: "get_pasteboard_preferences",
      args: { ignored: true },
      permission: "pasteboard.read",
      expected: {},
    },
    {
      cmd: "set_pasteboard_preferences",
      args: {
        preferences: {
          retentionDays: 30,
          blobBudgetBytes: 536_870_912,
          privacyLiterals: [" PRIVATE ", "internal"],
          screenShareProtection: true,
        },
      },
      permission: "pasteboard.write",
      expected: {
        preferences: {
          retentionDays: 30,
          blobBudgetBytes: 536_870_912,
          privacyLiterals: ["PRIVATE", "internal"],
          screenShareProtection: true,
        },
      },
    },
    {
      cmd: "get_pasteboard_sync_settings",
      args: { ignored: true },
      permission: "pasteboard.sync",
      expected: {},
    },
    {
      cmd: "sync_pasteboard_vault",
      args: {},
      permission: "pasteboard.sync",
      expected: {},
    },
  ];

  for (const [index, testCase] of validCases.entries()) {
    invokeCalls.length = 0;
    permissionCalls.length = 0;
    const result = await dispatch(mainSource, {
      __ipc_call__: true,
      reqId: 100 + index,
      cmd: testCase.cmd,
      args: testCase.args,
    });
    assert.equal(result.handled, true);
    assert.deepEqual(permissionCalls, [testCase.permission]);
    assert.deepEqual(invokeCalls, [{ command: testCase.cmd, args: testCase.expected }]);
  }

  const malformedAllowedCalls = [
    { cmd: "get_plugin_data_item", args: { docId: "" } },
    { cmd: "put_plugin_data", args: { doc: { title: "missing id" } } },
    { cmd: "put_plugin_data", args: { doc: { _id: "doc", value: undefined } } },
    { cmd: "put_plugin_data_bulk", args: { docs: "not-an-array" } },
    { cmd: "remove_plugin_data", args: { docId: 42 } },
    { cmd: "copy_text", args: { text: 42 } },
    { cmd: "show_notification", args: { message: null } },
    { cmd: "system_get_path", args: { name: "root" } },
    { cmd: "shell_open", args: { url: "" } },
    { cmd: "pasteboard_list_items", args: { limit: "40" } },
    { cmd: "pasteboard_list_items", args: { limit: 10_001 } },
    { cmd: "pasteboard_create_pinboard", args: { name: "Design", color: "purple" } },
    { cmd: "pasteboard_rename_pinboard", args: { id: "board-1", name: "" } },
    { cmd: "pasteboard_update_pinboard", args: { id: "board-1", color: "purple" } },
    { cmd: "pasteboard_update_pinboard", args: { id: "board-1" } },
    { cmd: "pasteboard_move_pinboard", args: { id: "" } },
    { cmd: "pasteboard_delete_pinboard", args: { id: "" } },
    { cmd: "pasteboard_assign_items", args: { itemIds: [], pinboardId: null } },
    { cmd: "pasteboard_create_text_item", args: { text: "" } },
    { cmd: "pasteboard_update_text_item", args: { itemId: "item-1", text: "" } },
    { cmd: "pasteboard_update_item_title", args: { itemId: "item-1", title: "" } },
    { cmd: "set_pasteboard_capture_paused", args: { paused: "true" } },
    { cmd: "set_pasteboard_preferences", args: { preferences: { retentionDays: 0 } } },
    { cmd: "set_pasteboard_preferences", args: { preferences: { retentionDays: 30, blobBudgetBytes: 1, privacyLiterals: [], screenShareProtection: true } } },
    { cmd: "pasteboard_get_item_preview", args: { itemId: "" } },
    { cmd: "pasteboard_recognize_item", args: { itemId: "" } },
    { cmd: "pasteboard_rotate_image", args: { itemId: "item-1", quarterTurns: 2 } },
    { cmd: "pasteboard_quick_look_item", args: { itemId: "" } },
    { cmd: "pasteboard_paste_item", args: { itemId: "", plainText: false } },
    { cmd: "pasteboard_paste_item", args: { itemId: "item-1", plainText: "true" } },
    { cmd: "pasteboard_copy_item", args: { itemId: "", plainText: false } },
    { cmd: "pasteboard_copy_item", args: { itemId: "item-1", plainText: "false" } },
  ];
  for (const [index, testCase] of malformedAllowedCalls.entries()) {
    invokeCalls.length = 0;
    permissionCalls.length = 0;
    await assert.rejects(
      dispatch(mainSource, { __ipc_call__: true, reqId: 200 + index, ...testCase }),
      /Invalid plugin invoke args/,
    );
    assert.equal(invokeCalls.length, 0, `${testCase.cmd} malformed args must not invoke`);
    assert.equal(permissionCalls.length, 0, `${testCase.cmd} malformed args must not authorize`);
  }

  assert.equal(policy.nativePluginPermissionForMethod("showOpenDialog"), "dialog.open");
  assert.equal(policy.nativePluginPermissionForMethod("set_setting"), null);
  assert.equal(policy.nativePluginPermissionForMethod("processExit"), null);
  assert.equal(policy.nativePluginPermissionForMethod("readTextFile"), null);

  for (const permissions of [undefined, null, "*", "data", {}, [], [""], [null]]) {
    assert.equal(
      policy.pluginPermissionListAllows(permissions, "data"),
      false,
      `missing or invalid manifest permissions must fail closed: ${JSON.stringify(permissions)}`,
    );
  }
  assert.equal(policy.pluginPermissionListAllows(["data"], "data"), true, "an explicit leaf should allow itself");
  assert.equal(
    policy.pluginPermissionListAllows(["shell"], "shell.openExternal"),
    true,
    "an explicit group should allow its child permission",
  );
  assert.equal(
    policy.pluginPermissionListAllows(["shell.*"], "shell.openPath"),
    true,
    "an explicit group wildcard should allow its child permission",
  );
  assert.equal(policy.pluginPermissionListAllows(["*"], "screen.capture"), true, "explicit wildcard should remain supported");
  assert.equal(
    policy.pluginPermissionListAllows(["clipboard.read"], "clipboard.write"),
    false,
    "an unrelated explicit leaf must not allow another permission",
  );

  assert.deepEqual(
    policy.resolvePluginPermissionRequest({ reqId: 7, permission: "clipboard.write" }),
    { reqId: 7, permission: "clipboard.write" },
  );
  for (const permission of ["", "*", "shell", "shell.*", "unknown", "process.exit", "fs.read"]) {
    assert.throws(
      () => policy.resolvePluginPermissionRequest({ reqId: 8, permission }),
      /Unsupported plugin permission/,
      `direct permission request ${permission || "(empty)"} must fail closed`,
    );
  }

  assert.deepEqual(
    policy.bindNativeBridgeArgsToSource(
      "sendToParent",
      { channel: "pong", args: ["hello"], windowType: "browserWindow", browserWindowId: "spoofed" },
      { kind: "child", windowId: "child-1" },
    ),
    { channel: "pong", args: ["hello"], windowType: "browserWindow", browserWindowId: "child-1" },
    "sendToParent must derive child window id from the source registry",
  );
  assert.deepEqual(
    policy.bindNativeBridgeArgsToSource(
      "sendToParent",
      { channel: "pong", args: [], windowType: "browserWindow", browserWindowId: "child-1" },
      { kind: "main" },
    ),
    { channel: "pong", args: [], windowType: "main", browserWindowId: "" },
    "the main iframe must not impersonate a hosted child",
  );
  assert.deepEqual(
    policy.bindNativeBridgeArgsToSource(
      "browserWindowAction",
      { id: "other-child", action: "webContents.executeJavaScript", args: ["41 + 1"] },
      { kind: "child", windowId: "child-1" },
    ),
    { id: "child-1", action: "webContents.executeJavaScript", args: ["41 + 1"] },
    "a hosted child must only target its source-bound BrowserWindow id",
  );
  assert.deepEqual(
    policy.bindNativeBridgeArgsToSource(
      "browserWindowAction",
      { id: "child-2", action: "show", args: [] },
      { kind: "main" },
    ),
    { id: "child-2", action: "show", args: [] },
    "the main plugin handle must retain control over any of its hosted children",
  );

  sources.unregisterChild("child-1", childSource);
  assert.equal(sources.identify(childSource), null, "closed child sources must stop being trusted immediately");
  sources.clear();
  assert.equal(sources.identify(mainSource), null, "clearing the registry must revoke the main source");
} finally {
  await rm(outDir, { recursive: true, force: true });
}

console.log("plugin invoke policy tests passed");
