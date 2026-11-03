import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const reviewedStorageSources = Object.freeze({
  theme: { path: "ZTools-plugins/plugins/stickercan/theme-manager.js", sha256: "3266aef30a4ca1a359aaf3c45aaad569c90ef1457e463f2c79f78cecf5c54e29" },
  ui: { path: "ZTools-plugins/plugins/stickercan/ui-manager.js", sha256: "dd289bd6d7a51f53b2cb56a7501a7af770b6f9e25c292de19943adf3911346bb" },
});

async function readReviewedClass(root, descriptor) {
  const bytes = await readFile(join(root, descriptor.path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== descriptor.sha256) throw Error("Reviewed original class changed: " + descriptor.path);
  return { source: bytes.toString("utf8"), sha256 };
}

/** Generate two pure-Web packages containing only the two fixed-hash original classes. */
export async function createWebStorageFixturePackages(root, environmentRoot) {
  const theme = await readReviewedClass(root, reviewedStorageSources.theme);
  const ui = await readReviewedClass(root, reviewedStorageSources.ui);
  const directory = join(environmentRoot, "web-storage-packages");
  await mkdir(directory, { mode: 0o700 });
  for (const id of ["file-tree", "char-transform"]) {
    const plugin = join(directory, id);
    await mkdir(plugin, { mode: 0o700 });
    const active = id === "file-tree";
    const manifest = {
      name: id, title: active ? "本地存储验收 A" : "本地存储验收 B", version: "0.0.0-synthetic",
      main: "index.html", description: "Generated Web Storage acceptance package",
      features: [{ code: active ? "web-storage-a" : "web-storage-b", explain: "本地存储验收", cmds: [active ? "synthetic web storage A" : "synthetic web storage B"] }],
      permissions: [], syntheticFixture: { generated: true, originalPackage: false, reviewedClassesOnly: active },
    };
    await writeFile(join(plugin, "plugin.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    const scripts = active
      ? `${theme.source}\nwindow.__AToolsThemeManager=ThemeManager;\n${ui.source}\nwindow.__AToolsUIManager=UIManager;`
      : `window.__AToolsStorageB={read:function(){return localStorage.getItem('namespace-check');},write:function(){localStorage.setItem('namespace-check','B');}};`;
    const dom = active
      ? `<div class="sidebar"><button id="sidebarCollapseBtn" type="button"><i id="collapseIcon"></i></button></div><input name="theme" type="radio" value="dark">`
      : `<main id="storage-b">B</main>`;
    const fixture = active ? `window.matchMedia=window.matchMedia||function(){return {matches:false,addEventListener:function(){}}};
window.__AToolsRunStorageFixture=function(){
  const theme=new ThemeManager();theme.setUserPreference('dark');
  const manager=new UIManager({});manager.initSidebarState();document.getElementById('sidebarCollapseBtn').click();
  localStorage.setItem('utf16-key-\ud800','utf16-value-\udfff');
  return {themeApplied:document.documentElement.dataset.theme==='dark',radioChecked:document.querySelector('input[name="theme"][value="dark"]').checked,
    sidebarCollapsed:document.querySelector('.sidebar').classList.contains('collapsed'),sidebarStored:localStorage.getItem('sidebarCollapsed')==='true'};
};` : "";
    const escapeScript = `${scripts}\n${fixture}`.replace(/<\/script/gi, "<\\/script");
    await writeFile(join(plugin, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>${manifest.title}</title></head><body>${dom}<script>${escapeScript}</script></body></html>`, { flag: "wx", mode: 0o600 });
  }
  return { directory, originalClasses: { theme: { ...reviewedStorageSources.theme, executed: true }, ui: { ...reviewedStorageSources.ui, executed: true } }, packageIds: ["file-tree", "char-transform"] };
}
