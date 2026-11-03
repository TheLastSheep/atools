import "../../src/styles/global.css";
import { mount, tick, unmount } from "svelte";
import PluginContextMenuOverlay from "../../src/components/PluginContextMenuOverlay.svelte";
import { createPluginContextMenuController } from "../../src/lib/pluginContextMenuController.svelte.js";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import type { PluginContextMenuItem } from "../../src/lib/pluginContextMenuSchema";

const registry = new PluginFrameSourceRegistry();
const root = document.getElementById("overlay-root");
if (!root) throw new Error("Context-menu fixture roots are missing");
let frame = document.getElementById("plugin-frame") as HTMLIFrameElement;
registry.registerChild("menu-fixture", frame.contentWindow);
let source: Window = frame.contentWindow!;
let identity = registry.identify(source);
if (!identity) throw new Error("Context-menu fixture frame registration failed");
const controller = createPluginContextMenuController(registry);
const overlay = mount(PluginContextMenuOverlay, { target: root, props: { controller } });
let selections = 0;
const state = (id: string) => document.getElementById(id)!;
const update = () => {
  state("menu-state").textContent = controller.menu ? "已打开" : "已关闭";
  state("selection-count").textContent = String(selections);
  state("document-generation").textContent = String(identity?.generation ?? "已失效");
};
const ordinary: PluginContextMenuItem[] = [
  { id: "petdex-desktop-pet:zoom-in", label: "放大" }, { id: "petdex-desktop-pet:zoom-out", label: "缩小" },
  { id: "petdex-desktop-pet:opacity-increase", label: "透明度+" },
  { id: "petdex-desktop-pet:opacity-decrease", label: "透明度-" }, { id: "petdex-desktop-pet:close", label: "关闭" },
];
const nested: PluginContextMenuItem[] = [
  { id: "fixture:enabled", label: "启用选项", type: "checkbox", checked: true },
  { id: "fixture:disabled", label: "禁用选项", enabled: false },
  { type: "separator" },
  { label: "编辑", type: "submenu", submenu: [
    { label: "变换", type: "submenu", submenu: [
      { id: "fixture:flip", label: "水平翻转" }, { id: "fixture:crop", label: "裁剪" },
    ] },
  ] },
];
const long: PluginContextMenuItem[] = Array.from({ length: 32 }, (_, index) => ({
  id: `fixture:long:${index + 1}`, label: `固定菜单项 ${String(index + 1).padStart(2, "0")}`,
}));
async function open(items: PluginContextMenuItem[]) {
  if (!identity) throw new Error("Current fixture document is not registered");
  await controller.open(items, source, identity, id => {
    selections++;
    state("selected-id").textContent = id;
    update();
  });
  await tick();
  update();
}
document.getElementById("open-five")!.addEventListener("click", () => void open(ordinary));
document.getElementById("open-nested")!.addEventListener("click", () => void open(nested));
document.getElementById("open-long")!.addEventListener("click", () => void open(long));
document.getElementById("close-menu")!.addEventListener("click", () => { controller.close(); update(); });
document.getElementById("replace-document")!.addEventListener("click", () => {
  registry.unregisterChild("menu-fixture", source);
  const next = document.createElement("iframe");
  next.id = "plugin-frame";
  next.title = "合成插件 frame";
  next.srcdoc = "<!doctype html><html><body>替换后的固定 frame source</body></html>";
  frame.replaceWith(next);
  frame = next;
  source = frame.contentWindow!;
  registry.registerChild("menu-fixture", source);
  identity = registry.identify(source);
  update();
});
const observer = new MutationObserver(update);
observer.observe(root, { childList: true, subtree: true });
window.addEventListener("pagehide", () => {
  observer.disconnect();
  controller.close();
  registry.unregisterChild("menu-fixture", source);
  unmount(overlay);
}, { once: true });
update();
