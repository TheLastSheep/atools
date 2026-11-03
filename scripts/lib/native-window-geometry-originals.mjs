import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSourceFile, forEachChild, isCallExpression, isFunctionDeclaration, isStringLiteral, ScriptTarget } from "typescript";

/** Exact reviewed function bodies only. Never evaluate original clipboard, FS, image or network workflows. */
export async function reviewedWindowGeometryOriginals(root) {
  const pins = [
    { path: "ZTools-plugins/plugins/english-typing-practice/preload.js", sha256: "c4f56a73f902f2840ea496805951110b1ea47a3dee987125a7588783db98ea41" },
    { path: "ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js", sha256: "64799173ad66b029c4341fc8b97eec8f583f8e390b184c71e96b4833164e7be3" },
  ];
  let typing = ""; const handlers = {};
  for (const pin of pins) {
    const bytes = await readFile(join(root, pin.path));
    if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) throw Error("Reviewed geometry original changed: " + pin.path);
    const ast = createSourceFile(pin.path, bytes.toString("utf8"), ScriptTarget.ESNext, true);
    if (pin.path.includes("english-typing")) {
      const functions = ast.statements.filter(node => isFunctionDeclaration(node) && ["getWinInfo", "hasWinInstance"].includes(node.name?.text));
      if (functions.length !== 2) throw Error("Reviewed typing geometry functions missing");
      typing = functions.map(node => node.getText(ast)).join("\n");
    } else {
      function visit(node) {
        if (isCallExpression(node) && node.expression.getText(ast) === "ipcRenderer.on" && isStringLiteral(node.arguments[0])
          && ["floater:move", "floater:resize"].includes(node.arguments[0].text)) handlers[node.arguments[0].text] = node.arguments[1].getText(ast);
        forEachChild(node, visit);
      }
      visit(ast);
    }
  }
  if (!handlers["floater:move"] || !handlers["floater:resize"]) throw Error("Reviewed paintbrush geometry callbacks missing");
  return { pins, script: `(function(){${typing}\nwindow.__AToolsOriginalGeometryInfo=getWinInfo;
window.__AToolsOriginalGeometryMove=function(win,data){return (${handlers["floater:move"]})(null,data);};
window.__AToolsOriginalGeometryResize=function(win,data){return (${handlers["floater:resize"]})(null,data);};})();` };
}
