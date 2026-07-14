import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-host-view-"));
const outFile = join(outDir, "pluginHostView.mjs");

try {
  const sourcePath = new URL("src/lib/pluginHostView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const bridgeSourcePath = new URL("src/lib/pluginBridgeCapabilities.ts", root).pathname;
  const bridgeSource = await readFile(bridgeSourcePath, "utf8");
  const bridgeTransformed = await transformWithEsbuild(bridgeSource, bridgeSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "pluginBridgeCapabilities"), bridgeTransformed.code);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(typeof mod.normalizePluginOutputItems, "function");
  assert.deepEqual(mod.normalizePluginOutputItems({ items: [{ title: "A", description: "Alpha", data: "a" }] }), [
    { title: "A", description: "Alpha", data: "a" },
  ]);
  assert.deepEqual(mod.normalizePluginOutputItems([{ items: [{ title: "B", description: "Beta" }] }]), [
    { title: "B", description: "Beta" },
  ]);
  assert.deepEqual(mod.normalizePluginOutputItems([{ title: "C", data: 123 }, { bad: true }, null]), [
    { title: "C", data: "123" },
  ]);
  assert.deepEqual(mod.normalizePluginOutputItems({ items: [] }), []);
  assert.deepEqual(mod.normalizePluginOutputItems(null), []);

  const action = {
    plugin_id: "timestamp",
    plugin_name: "时间戳",
    feature_code: "timestamp",
    main_url: "index.html",
    plugin_path: "/plugins/timestamp",
    expand_height: 420,
    payload: null,
  };

  const outputView = mod.pluginHostView(action, {
    subInputVisible: true,
    iframeReady: true,
    outputItems: [
      { title: "当前时间戳", description: "秒", data: "1710000000" },
      { title: "当前时间戳毫秒", description: "毫秒", data: "1710000000000" },
    ],
    selectedIndex: 1,
    loadError: "",
  });
  assert.deepEqual(outputView.chrome, {
    title: "时间戳",
    feature: "timestamp",
    source: "timestamp",
  });
  assert.deepEqual(outputView.actions.map((action) => [action.id, action.label, action.available]), [
    ["back", "返回", true],
    ["settings", "设置", false],
    ["detach", "分离", true],
  ]);
  assert.equal(outputView.bodyMode, "output");
  assert.equal(outputView.iframeClass, "plugin-iframe full-bleed");
  assert.equal(outputView.outputLayerClass, "plugin-output-layer");
  assert.deepEqual(outputView.layoutSlots, ["titlebar", "runtime", "subinput", "body"]);
  assert.deepEqual(outputView.runtimeChips.map((chip) => [chip.label, chip.value, chip.tone]), [
    ["运行状态", "输出层", "ready"],
    ["SubInput", "已启用", "ready"],
    ["输出结果", "2 项", "ready"],
    ["桥接能力", "utools/ztools", "normal"],
  ]);
  assert.equal(outputView.runtimeChips.some((chip) => chip.label === "动态指令"), false);
  assert.equal(outputView.runtimeChips[0].detail, "插件已返回可选结果");
  assert.equal(outputView.runtimeChips[2].detail, "方向键选择，Enter 复制");
  assert.deepEqual(outputView.outputRows.map((row) => [row.title, row.selected, row.actionHint]), [
    ["当前时间戳", false, ""],
    ["当前时间戳毫秒", true, "Enter 复制"],
  ]);

  const iframeView = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
    loadError: "",
  });
  assert.deepEqual(iframeView.layoutSlots, ["titlebar", "runtime", "body"]);
  assert.equal(iframeView.bodyMode, "iframe");
  assert.equal(iframeView.outputRows.length, 0);
  assert.deepEqual(iframeView.runtimeChips.map((chip) => [chip.label, chip.value, chip.detail]), [
    ["运行状态", "iframe", "插件页面已载入"],
    ["SubInput", "未启用", "插件未请求输入框"],
    ["输出结果", "0 项", "等待插件调用 outPlugin"],
    ["桥接能力", "utools/ztools", "DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文"],
  ]);

  const contextMenuView = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
    loadError: "",
    contextMenuTarget: "iframe button",
  });
  assert.deepEqual(contextMenuView.runtimeChips.at(-1), {
    label: "右键菜单",
    value: "iframe button",
    detail: "iframe 已上报 contextmenu，宿主保留插件自定义事件路径",
    tone: "ready",
  });

  const probeView = mod.pluginHostView(action, {
    subInputVisible: false,
    iframeReady: true,
    outputItems: [],
    selectedIndex: 0,
    loadError: "",
    uiHostProbePassed: 5,
    uiHostProbeTotal: 5,
  });
  assert.deepEqual(probeView.runtimeChips.at(-1), {
    label: "宿主探针",
    value: "5/5",
    detail: "iframe 已回传 bridge/lifecycle 探针",
    tone: "ready",
  });

  const errorView = mod.pluginHostView(action, {
    subInputVisible: true,
    iframeReady: false,
    outputItems: [],
    selectedIndex: 0,
    loadError: "无法加载插件",
  });
  assert.equal(errorView.bodyMode, "error");
  assert.equal(errorView.loadError, "无法加载插件");
  assert.equal(errorView.runtimeChips[0].value, "加载失败");
  assert.equal(errorView.runtimeChips[0].tone, "error");

  const [componentSource, appSource] = await Promise.all([
    readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
  ]);
  assert.match(componentSource, /aria-label="插件运行状态"/);
  assert.match(componentSource, /hostView\.runtimeChips/);
  assert.match(componentSource, /class="plugin-runtime-strip"/);
  assert.match(componentSource, /class="runtime-chip"/);
  assert.match(componentSource, /function handlePluginChromeAction/, "plugin chrome actions should route through an explicit handler");
  assert.match(componentSource, /case "detach":/, "detach chrome action should have a host implementation");
  assert.match(componentSource, /dispatchPluginDetachEvent\(\)/, "detach action should notify the plugin iframe lifecycle");
  assert.match(componentSource, /onclick=\{\(\) => handlePluginChromeAction\(chromeAction\.id\)\}/, "plugin chrome buttons should invoke the host action handler");
  assert.match(componentSource, /\.plugin-runtime-strip\s*\{[\s\S]*?display:\s*grid;/);
  assert.match(componentSource, /\.runtime-chip\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(componentSource, /WEB_PREVIEW_PLUGIN_PATH/);
  assert.match(componentSource, /loadPreviewPluginHtml/);
  assert.match(componentSource, /let iframeSrc = \$state\(""\)/, "PluginPanel should track preview iframe src for generated real-entry fixtures");
  assert.match(componentSource, /payload\.iframeSrc/, "PluginPanel preview payload should accept a generated fixture URL");
  assert.match(componentSource, /src=\{iframeSrc \|\| undefined\}/, "PluginPanel iframe should use src when preview loads a generated fixture URL");
  assert.match(componentSource, /srcdoc=\{iframeSrc \? undefined : iframeSrcDoc\}/, "PluginPanel iframe should not keep srcdoc when src is active");
  assert.match(componentSource, /__atools_real_entry_fixture_probe__/, "PluginPanel should consume generated real-entry fixture probe messages");
  assert.match(componentSource, /__atools_plugin_panel_real_entry_probe__/, "PluginPanel should forward real-entry fixture probes to matrix parents");
  assert.match(componentSource, /errorMessages/, "PluginPanel should preserve real-entry fixture error messages for matrix diagnostics");
  assert.match(componentSource, /errors:\s*errorMessages/, "PluginPanel matrix probe payload should include fixture error messages");
  assert.match(componentSource, /window\.parent\.postMessage/, "PluginPanel should use postMessage to report matrix probe results");
  assert.match(componentSource, /uiHostProbeResult/, "PluginPanel should retain UI host probe results from iframe");
  assert.match(componentSource, /function handleUiHostProbeResult/, "PluginPanel should normalize UI host probe result messages");
  assert.match(componentSource, /__atools_ui_host_probe_result__/, "PluginPanel should consume UI host probe result messages");
  assert.match(componentSource, /report_plugin_panel_render_smoke/, "PluginPanel should report real Tauri FS render smoke results");
  assert.match(componentSource, /VITE_ATOOLS_DESKTOP_SMOKE/, "PluginPanel render smoke should only run for desktop smoke");
  assert.match(componentSource, /iframeSrcdocLoaded/, "PluginPanel render smoke should prove srcdoc was populated");
  assert.match(componentSource, /expectedSamples/, "PluginPanel render smoke should report the expected action count");
  assert.match(componentSource, /sampleIndex/, "PluginPanel render smoke should report its action index");
  assert.match(componentSource, /externalPlanSample/, "PluginPanel render smoke should mark external activation-plan samples");
  assert.match(componentSource, /__atools_desktop_smoke_bridge_probe__/, "PluginPanel desktop smoke should consume iframe bridge probe messages");
  assert.match(componentSource, /waitForDesktopSmokeBridgeProbe/, "PluginPanel desktop smoke should wait for iframe bridge probes before reporting");
  assert.match(componentSource, /function desktopSmokeBridgeProbeTimeoutMs/, "PluginPanel desktop smoke should size the bridge probe timeout for large srcdoc samples");
  assert.match(componentSource, /Math\.max\(12000/, "PluginPanel desktop smoke should give lazy-loaded large plugin hosts enough bridge probe time");
  assert.match(componentSource, /Math\.min\(20000/, "PluginPanel desktop smoke should leave the bounded BrowserWindow isolation probe enough outer wait budget");
  assert.match(componentSource, /waitForDesktopSmokeBridgeProbe\([\s\S]*?html\.length/, "PluginPanel desktop smoke should pass srcdoc size into the bridge probe wait budget");
  assert.match(componentSource, /bridgeProbePassed/, "PluginPanel render smoke should report bridge probe pass state");
  assert.match(componentSource, /bridgeProbeChecks/, "PluginPanel render smoke should report bridge probe check counts");
  assert.match(componentSource, /nativeMethodProbes/, "PluginPanel desktop smoke should report native/system method probe results");
  assert.match(componentSource, /nativeMethodProbePassed/, "PluginPanel render smoke should report native method probe pass state");
  assert.match(componentSource, /desktop-bridge-native-get-path/, "PluginPanel desktop smoke should probe system getPath from inside the iframe");
  assert.match(componentSource, /desktop-bridge-native-capture-sources/, "PluginPanel desktop smoke should probe parent-mediated desktopCaptureSources");
  assert.match(componentSource, /ondesktopsmokerender/, "PluginPanel should notify App after each desktop smoke render report");
  assert.match(componentSource, /normalizePluginOutputItems\(payload\.outputItems/);
  assert.match(appSource, /initialPluginHostSmokeAction/);
  assert.match(appSource, /pluginHostSmoke/);
  assert.match(appSource, /__atools_plugin_host_preview__/);
  assert.match(appSource, /desktop_smoke_plugin_panel_actions/, "desktop smoke should request real PluginPanel actions from Tauri");
  assert.match(appSource, /activateDesktopSmokePluginPanel/, "desktop smoke should auto-open a real PluginPanel");
  assert.match(appSource, /desktopSmokePluginActions/, "desktop smoke should retain a render action queue");
  assert.match(appSource, /handleDesktopSmokePluginPanelRender/, "desktop smoke should advance after each PluginPanel report");
  assert.doesNotMatch(appSource, /import PluginPanel from/, "PluginPanel should stay out of the initial app chunk");
  assert.match(appSource, /import\("\.\/components\/PluginPanel\.svelte"\)/, "App should lazy-load PluginPanel on demand");
  assert.match(
    appSource,
    /ondesktopsmokerender:\s*queueActive \? handleDesktopSmokePluginPanelRender : undefined/,
    "App should wire the PluginPanel render callback only for the active desktop smoke queue item",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
