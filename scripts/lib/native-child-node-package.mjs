import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const originalChildPreload = Object.freeze({
  source: "ZTools-plugins/plugins/english-typing-practice/preload-app.js",
  sha256: "04a323ba2e891865e97b375359458578700fae0e7033b405a44f098b331fb961",
});
export const childNodeFixtureValues = Object.freeze({
  sentinel: "ATools child-only Node fixed sentinel 31",
  dictionary: [{ name: "atools-child-dictionary-word-31", trans: ["fixed fixture translation"] }],
  metadata: { id: "atools-child-dictionary-31", name: "ATools child dictionary fixture 31", length: 1 },
});

function parentDataScript() {
  return `(function(){
  const state={entered:true,storageApiAvailable:typeof window.ztools?.dbStorage?.setItem==='function',attempted:false,completed:false,errorClass:'',errorCode:''};
  window.__AToolsChildMainStage=state;
  try{state.attempted=true;ztools.dbStorage.setItem("fixture-child-main-ready","atools-child-main-private-31");state.completed=true;window.__AToolsChildMainReady=true;}
  catch(error){state.errorClass=['Error','TypeError','ReferenceError','SyntaxError','RangeError'].includes(error?.name)?error.name:'UnknownError';
    state.errorCode=['ERR_ATOOLS_DATA_PERMISSION_REQUIRED','ERR_ATOOLS_DATA_SESSION','ERR_ATOOLS_DATA_CLOSED','ERR_ATOOLS_DATA_RESPONSE','ERR_ATOOLS_DATA_TRANSPORT','ERR_ATOOLS_DATA_REJECTED','ERR_ATOOLS_DATA_LIMIT'].includes(error?.code)?error.code:'UNKNOWN_ERROR';throw error;}
})();`;
}

export async function reviewedOriginalChildPreload(root) {
  const bytes = await readFile(join(root, originalChildPreload.source));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== originalChildPreload.sha256) throw Error("Reviewed original English child preload changed");
  return { bytes, sha256 };
}

/** Generated parent/HTML/manifest; only the complete original child preload is unchanged. */
export async function createChildNodeFixturePackages(root, environmentRoot) {
  const original = await reviewedOriginalChildPreload(root);
  const directory = join(environmentRoot, "child-node-packages");
  await mkdir(directory, { mode: 0o700 });
  for (const id of ["file-tree", "char-transform"]) {
    const packageRoot = join(directory, id); await mkdir(packageRoot, { mode: 0o700 });
    const active = id === "file-tree";
    const manifest = { name: id, title: active ? "子窗口 Node 验收" : "子窗口未使用占位", version: "0.0.0-synthetic",
      main: "index.html", ...(active ? { preload: "parent-preload.js" } : {}),
      description: "Generated child-only Node acceptance; not a complete original plugin",
      permissions: active ? ["browserWindow"] : [],
      features: [{ code: active ? "child-node-contract" : "unused", explain: "Synthetic child-only Node contract",
        cmds: [active ? "synthetic child only node" : "synthetic unused child node"] }],
      syntheticFixture: { generated: true, originalPackage: false, completeOriginalChildPreloadOnly: active } };
    const files = {
      "plugin.json": JSON.stringify(manifest, null, 2),
      "index.html": '<!doctype html><meta charset="utf-8"><title>Private child-only Node fixture</title><p>Generated parent; only selected child asks for Node.</p>'
        + (active ? '<script>' + parentDataScript() + '</script>' : ""),
    };
    if (active) Object.assign(files, {
      "parent-preload.js": 'const {ipcRenderer}=require("electron");window.__AToolsChildParentPreload={executed:true,electronIpc:typeof ipcRenderer.sendTo==="function"};',
      "child.html": '<!doctype html><meta charset="utf-8"><title>Private generated child</title><p>Fixed child-only Node fixture</p>',
      "child-preload.js": 'const fs=require("fs");const process=require("process");window.__AToolsChildSentinel={value:fs.readFileSync("fixture-sentinel.txt","utf8"),pid:process.pid};',
      "fixture-sentinel.txt": childNodeFixtureValues.sentinel,
      "fixture-dictionary.json": JSON.stringify(childNodeFixtureValues.dictionary),
      "preload-app.js": original.bytes,
    });
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(packageRoot, name), bytes, { flag: "wx", mode: 0o600 });
  }
  return { directory, packageIds: ["file-tree", "char-transform"],
    originalChildPreload: { ...originalChildPreload, copiedSha256: original.sha256, completeUnmodifiedFile: true },
    scope: "Generated parent and pages; complete unchanged original English child preload only; no complete original plugin" };
}
