import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const reviewedNodePageSources = Object.freeze({
  imageStitch: {
    id: "image-stitch",
    files: {
      "index.html": "adcf0f4c9ef0edaa0af82e32de69bfdd78177a762703639a43a49cb25b62555a",
      "app.js": "37105dde6dad683d2c4b211ccf51392f5f148c6c8bb02e20c3a264464133384c",
      "style.css": "9a63b48da340825c643f3bc5aee935e33171221089563ca28f871c6db8996093",
      "logo.svg": "0cb4b56c26c417e89f44fcb4929dcb0e826ede43dd74650b8f1aff6e83870d1e",
    },
  },
  developerCodecTools: {
    id: "developer-codec-tools",
    files: {
      "index.html": "579ee999e9a728416e516bae3f67b2dcee4ec0aad7db0e1584517247e30da072",
      "app.js": "b322e7a33b4900ab18c9c82e0fb1b3e751d1ba67785de65a9cac29af40b594ad",
      "codec.js": "60df2fdb863a1b9b461c6edad86fddd6a88d67a1e27d8c3014eb389bba726eaa",
      "styles.css": "8996ceb5473210d2ed2131468615ea6d407d2a37e3c3e3b4be6a614bddee6a05",
      "logo.svg": "5c3ff552c461210fbabdd0e6438bf47408ce8c8f8a52db3f07c368478dfcf92d",
    },
  },
});

async function readReviewed(root, packageInfo, file) {
  const bytes = await readFile(join(root, "ZTools-plugins/plugins", packageInfo.id, file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== packageInfo.files[file]) throw Error("Reviewed plugin source hash mismatch: " + packageInfo.id + "/" + file);
  return { bytes, sha256 };
}

function saveFunctions(source) {
  const start = source.indexOf("  function getOutputMimeType() {");
  const end = source.indexOf("  function copyToClipboard() {", start);
  if (start < 0 || end < 0) throw Error("Reviewed image save functions were not found");
  const block = source.slice(start, end);
  if (!block.startsWith("  function getOutputMimeType() {\n") || !block.includes("  function saveImage() {\n"))
    throw Error("Reviewed image save function shape changed");
  return block;
}

function manifest(id, title, code, command, description) {
  return {
    name: id, title, version: "0.0.0-synthetic", main: "index.html", description,
    features: [{ code, explain: description, cmds: [command] }], permissions: [],
    syntheticFixture: { generated: true, originalPackage: false, reviewedOriginalUiAssets: true },
  };
}

/** Builds generated no-preload packages from exact, hash-pinned original UI assets. */
export async function createNodePageFixturePackages(root, environmentRoot, { outputPath }) {
  if (!outputPath) throw Error("Node page fixture requires a fixed native output path");
  const directory = join(environmentRoot, "node-page-packages");
  await mkdir(directory, { mode: 0o700 });
  const copied = {};
  for (const [key, info] of Object.entries(reviewedNodePageSources)) {
    const packageDir = join(directory, key === "imageStitch" ? "file-tree" : "char-transform");
    await mkdir(packageDir, { mode: 0o700 });
    copied[info.id] = {};
    for (const file of Object.keys(info.files)) {
      const original = await readReviewed(root, info, file);
      copied[info.id][file] = original.sha256;
      await writeFile(join(packageDir, file), original.bytes, { flag: "wx", mode: 0o600 });
    }
    const isImage = info.id === "image-stitch";
    const pluginId = isImage ? "file-tree" : "char-transform";
    const pkgManifest = manifest(pluginId, isImage ? "Node 页面验收 A" : "纯编码页面验收 B",
      isImage ? "node-page-image-stitch" : "node-page-codec-tools",
      isImage ? "synthetic node page image stitch" : "synthetic node page codec tools",
      "Generated 0.0.0-synthetic no-preload acceptance package");
    if (isImage) pkgManifest.main = "fixture-index.html";
    await writeFile(join(packageDir, "plugin.json"), JSON.stringify(pkgManifest, null, 2), { flag: "wx", mode: 0o600 });
    if (isImage) {
      const originalHtml = (await readReviewed(root, info, "index.html")).bytes.toString("utf8");
      const appSource = (await readReviewed(root, info, "app.js")).bytes.toString("utf8");
      const functions = saveFunctions(appSource);
      const fixtureScript = `(() => {
  const outputPath = ${JSON.stringify(outputPath)};
  const records = [];
  window.__AToolsNodePageMock = { records, outputPath, cancelNext: true };
  const nativeBridge = window.ztools;
  const mockBridge = Object.create(nativeBridge || null);
  mockBridge.showSaveDialog = function (options) {
    records.push({ kind: "save-dialog", title: options?.title, cancel: window.__AToolsNodePageMock.cancelNext });
    if (window.__AToolsNodePageMock.cancelNext) { window.__AToolsNodePageMock.cancelNext = false; return null; }
    return outputPath;
  };
  mockBridge.showNotification = function (message) { records.push({ kind: "notification", success: message === "图片已保存" }); };
  mockBridge.shellShowItemInFolder = function (path) { records.push({ kind: "reveal", matched: path === outputPath }); };
  window.ztools = mockBridge;
  const state = { images: [], format: "png", quality: 1 };
  const canvas = { toDataURL: (type) => {
    const live = document.querySelector("#canvas");
    if (!live) throw Error("CanvasUnavailable");
    const actual = live.toDataURL(type);
    return actual;
  } };
  const require = window.require;
  const Buffer = window.Buffer;
${functions}
  window.__AToolsNodePageSaveFixture = {
    setState(images, format) { state.images = images; state.format = format; },
    saveImage, getOutputMimeType,
    cancel() { state.images = [{}]; window.__AToolsNodePageMock.cancelNext = true; saveImage(); },
    write() { window.__AToolsNodePageMock.cancelNext = false; saveImage(); },
  };
})();`;
      await writeFile(join(packageDir, "fixture-save.js"), fixtureScript, { flag: "wx", mode: 0o600 });
      const fixtureHtml = originalHtml.replace("</body>", '<script src="fixture-save.js"></script>\n</body>');
      if (fixtureHtml === originalHtml) throw Error("Image UI fixture insertion point missing");
      await writeFile(join(packageDir, "fixture-index.html"), fixtureHtml, { flag: "wx", mode: 0o600 });
    }
  }
  return { directory, packageIds: ["file-tree", "char-transform"], copiedHashes: copied,
    exactSaveFunctions: true, originalsRemainUnmodified: true };
}
