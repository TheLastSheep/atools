import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createSourceFile, isFunctionDeclaration, ScriptTarget } from "typescript";
import { pluginDisplayBridgeScript, type PluginDisplaySnapshot } from "../../src/lib/pluginDisplayBridge";

const pins = {
  floating: ["ZTools-plugins/plugins/floating/preload.js", "727ecfc2f1f2d02b3b089a23d28b84f23c0452dfd18deea130c96fd886d24834"],
  lihua: ["ZTools-plugins/plugins/lihua/preload.js", "32228802780d753774f0533c69d597eed78d383c015f6fc278c41dc9c1b3668d"],
  yanhua: ["ZTools-plugins/plugins/yanhua/preload.js", "9b2b2a0338a3ef3400e7c9671ddf9fbefdabb9a659c252a8b7d13ca664d9bf0d"],
  shortcut: ["ZTools-plugins/plugins/shortcut-capture/public/preload.js", "b124320094b2d6f195c60ebcdf453206bced685cb3f2939a19a63eb145503722"],
  long: ["ZTools-plugins/plugins/long-screenshot/core/preload.js", "1df073d23c77ec0a440f2f182c9eb0a03f1804c43da3b44c919f76b33d32918e"],
} as const;
type Kind = keyof typeof pins;
const selected = { floating: ["show", "uuidv4"], lihua: ["createEffectWindow"], yanhua: ["createEffectWindow"],
  shortcut: ["createEditorWindow", "displayScaleFactor", "clamp", "editorStorageKey"], long: ["createMask"] };

/** Exact pinned original functions; image/window/storage/IPC observers are generated doubles, never OS actions. */
export async function originalDisplayFixture(kind: Kind, initial: PluginDisplaySnapshot) {
  const [file, hash] = pins[kind], source = await readFile(file, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== hash) throw Error("Original source changed: " + file);
  const ast = createSourceFile(file, source, ScriptTarget.ESNext, true);
  const declarations = ast.statements.filter(node => isFunctionDeclaration(node) && selected[kind].includes(node.name?.text ?? ""));
  if (declarations.length !== selected[kind].length) throw Error("Original display declarations missing");
  const extracted = declarations.map(node => node.getText(ast)).join("\n"), calls: any[] = [], reads: any[] = [], images: any[] = [], storage = new Map<string, unknown>();
  let snapshot = initial;
  const handle = { setIgnoreMouseEvents: (...args: any[]) => calls.push({ operation: "ignoreMouse", args }),
    setAlwaysOnTop: (...args: any[]) => calls.push({ operation: "alwaysOnTop", args }), isDestroyed: () => false };
  const ztools: any = {
    isMacOs: () => true, isMacOS: () => true, hideMainWindow: () => calls.push({ operation: "hide" }), outPlugin: () => calls.push({ operation: "out" }),
    showNotification: (...args: unknown[]) => calls.push({ operation: "notification", args }),
    createBrowserWindow: (url: string, options: unknown) => { calls.push({ operation: "window", url, options }); return handle; },
    dbStorage: { setItem: (key: string, value: unknown) => storage.set(key, value) },
  };
  class ImageDouble { width = 8000; height = 4000; src = ""; onload?: () => void; constructor() { images.push(this); } }
  class XhrDouble { status = 200; responseText = "";
    open(method: string, endpoint: string, async: boolean) { reads.push({ method, endpoint, async }); }
    setRequestHeader() {} send(body: string) { reads.at(-1).body = body; this.responseText = JSON.stringify({ ok: true, result: snapshot }); }
  }
  const window: any = { utools: ztools, ztools, devicePixelRatio: 1, addEventListener() {}, parent: { postMessage: (...args: unknown[]) => calls.push({ operation: "permission", args }) } };
  const context = vm.createContext({ window, ztools, utools: ztools, XMLHttpRequest: XhrDouble, TextEncoder,
    Image: ImageDouble, localStorage: { setItem: (key: string, value: unknown) => storage.set(key, value) },
    console: { log() {} }, ipcRenderer: { on() {} }, isDev: false, isMacOs: true, scutMask: null,
    imageSize: () => ({ width: 1600, height: 900 }), editorUrl: (key: string) => "generated-editor/" + key,
    bindEditorCloseEvent: () => calls.push({ operation: "bindEditorClose" }),
    EDITOR_TOOLBAR_MIN_WIDTH: 620, EDITOR_MAX_VISIBLE_ASPECT: 5, EDITOR_BOTTOM_SHADOW_SPACE: 18,
    EDITOR_KEY_PREFIX: "generated-editor:", Math, Date,
  });
  vm.runInContext(pluginDisplayBridgeScript({ instanceId: "original-function-fixture", endpoint: "http://127.0.0.1:54321/display/" + "c".repeat(64) })
    .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""), context);
  vm.runInContext(extracted, context);
  return { calls, reads, storage, pins: { file, hash, selected: selected[kind] }, setSnapshot(next: PluginDisplaySnapshot) { snapshot = next; },
    async run() {
      if (kind === "floating") { vm.runInContext('show("generated-image", "generated-file")', context); images.at(-1).onload(); }
      else if (kind === "lihua" || kind === "yanhua") vm.runInContext('createEffectWindow("generated-effect.html")', context);
      else if (kind === "shortcut") await vm.runInContext('createEditorWindow("generated-image")', context);
      else vm.runInContext("createMask()", context);
    },
  };
}
