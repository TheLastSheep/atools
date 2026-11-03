import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import ts from "typescript";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZTOOLS_ROOT = path.resolve(process.env.ATOOLS_ZTOOLS_SOURCE ?? path.join(REPO_ROOT, "..", "ZTools"));
const ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const SEARCH_BOX = path.join(ZTOOLS_ROOT, "src/renderer/src/components/search/SearchBox.vue");
const PINNED_SFC_TOOLCHAIN = existsSync(SEARCH_BOX) &&
  existsSync(path.join(ZTOOLS_ROOT, "node_modules/.pnpm/node_modules/@vue/compiler-sfc")) &&
  existsSync(path.join(ZTOOLS_ROOT, "node_modules/vue"));
const requirePinned = createRequire(path.join(ZTOOLS_ROOT, "package.json"));
const requirePinnedPackages = createRequire(path.join(ZTOOLS_ROOT, "node_modules/.pnpm/package.json"));
const previousZtools = (window as unknown as Record<string, unknown>).ztools;

afterEach(() => {
  if (previousZtools === undefined) delete (window as unknown as Record<string, unknown>).ztools;
  else (window as unknown as Record<string, unknown>).ztools = previousZtools;
  vi.restoreAllMocks();
});

function compilePinnedSearchBoxPasteHandler(
  emit: (...args: unknown[]) => void,
  modelValue = "",
): { handler: (event: { preventDefault(): void }) => Promise<void>; inputRef: { value: unknown } } {
  if (!existsSync(SEARCH_BOX)) throw new Error("Pinned original SearchBox.vue is unavailable.");
  const actualCommit = execFileSync("git", ["-C", ZTOOLS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualCommit !== ZTOOLS_COMMIT) throw new Error("Original SearchBox source is not at the pinned ZTools commit.");

  const compilerPath = requirePinnedPackages.resolve("@vue/compiler-sfc");
  const { parse, compileScript, compileTemplate } = createRequire(compilerPath)("@vue/compiler-sfc");
  const filename = SEARCH_BOX;
  const { descriptor, errors } = parse(readFileSync(filename, "utf8"), { filename });
  if (errors.length !== 0 || !descriptor.template || !descriptor.scriptSetup) {
    throw new Error("Pinned SearchBox SFC could not be parsed.");
  }
  const script = compileScript(descriptor, { id: "atools-original-search-paste" });
  const template = compileTemplate({
    source: descriptor.template.content,
    filename,
    id: "atools-original-search-paste",
    compilerOptions: { bindingMetadata: script.bindings },
  });
  if (template.errors.length !== 0 || !descriptor.template.content.includes("@paste=\"handlePaste\"")) {
    throw new Error("Pinned SearchBox paste handler is not bound in its template.");
  }

  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const runtime = requirePinned("vue");
  const store = {
    currentPlugin: null,
    placeholder: "Search",
    subInputPlaceholder: "",
    subInputVisible: false,
    avatar: "",
    pluginLoading: false,
    tabKeyFunction: "navigate",
    tabTargetCommand: "",
    shouldShowUpdateNotification: false,
    aiRequestStatus: "idle",
    setAiRequestStatus() {},
    dismissUpdateNotification() {},
  };
  const module = { exports: {} as Record<string, unknown> };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "vue") {
      return {
        ...runtime,
        onMounted() {},
        onUnmounted() {},
        watch() { return () => undefined; },
      };
    }
    if (specifier === "@shared/pluginSettings") return { normalizeConfigList: () => [] };
    if (specifier === "../../stores/windowStore") {
      return { DEFAULT_AVATAR: "", useWindowStore: () => store };
    }
    if (specifier === "../common/AdaptiveIcon.vue" || specifier === "./UpdateIcon.vue") {
      return { default: {} };
    }
    throw new Error(`Unexpected pinned SearchBox dependency: ${specifier}`);
  };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: requireModule,
    window,
    console,
    setTimeout,
    clearTimeout,
    ResizeObserver: undefined,
  }, { timeout: 2_000 });
  const component = module.exports.default as {
    setup(props: Record<string, unknown>, context: { expose(value: unknown): void; emit: (...args: unknown[]) => void }): Record<string, unknown>;
  };
  const bindings = component.setup({
    modelValue,
    pastedImage: null,
    pastedFiles: null,
    pastedText: null,
    currentView: "search",
  }, { expose() {}, emit });
  return {
    handler: bindings.handlePaste as (event: { preventDefault(): void }) => Promise<void>,
    inputRef: bindings.inputRef as { value: unknown },
  };
}

function clipboardTransport(reply: unknown, calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }>): ZToolsRendererTransport {
  return {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_renderer_last_copied_content") return reply;
      throw new Error(`Unexpected renderer command: ${command}`);
    },
    async listen() { return () => undefined; },
  };
}

it.skipIf(!PINNED_SFC_TOOLCHAIN)("delivers copied text through the original SearchBox after browser paste is prevented", async () => {
  const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
  const adapter = createZtoolsRendererHostAdapter({
    transport: clipboardTransport({ type: "text", data: "clipboard fixture", timestamp: 1_798_000_000_000 }, calls),
  });
  (window as unknown as Record<string, unknown>).ztools = adapter.api;
  const emitted: unknown[][] = [];
  const component = compilePinnedSearchBoxPasteHandler((...args) => emitted.push(args));
  const event = { preventDefault: vi.fn() };

  await component.handler(event);

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(emitted).toEqual([["update:pastedText", "clipboard fixture"], ["update:modelValue", ""]]);
  expect(calls).toEqual([{ command: "get_renderer_last_copied_content", args: { timeLimit: null } }]);
  expect(adapter.snapshot().unsupportedMethods).not.toContain("getLastCopiedContent()");
  adapter.dispose();
});

it.skipIf(!PINNED_SFC_TOOLCHAIN)("preserves the original SearchBox image, file and selected-text paste branches", async () => {
  const replies = [
    { type: "image", data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD7sAAAAASUVORK5CYII=", timestamp: 1_798_000_000_000 },
    { type: "file", data: [{ path: "/tmp/fixture.txt", name: "fixture.txt", isFile: true, isDirectory: false }], timestamp: 1_798_000_000_000 },
    { type: "text", data: "X", timestamp: 1_798_000_000_000 },
  ];
  const expectedEvents = [
    [["update:pastedImage", replies[0].data], ["update:modelValue", ""]],
    [["update:pastedFiles", replies[1].data], ["update:modelValue", ""]],
    [["update:modelValue", "aXc"]],
  ];

  for (let index = 0; index < replies.length; index += 1) {
    const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
    const adapter = createZtoolsRendererHostAdapter({ transport: clipboardTransport(replies[index], calls) });
    (window as unknown as Record<string, unknown>).ztools = adapter.api;
    const emitted: unknown[][] = [];
    const component = compilePinnedSearchBoxPasteHandler(
      (...args) => emitted.push(args),
      index === 2 ? "abc" : "",
    );
    if (index === 2) {
      component.inputRef.value = { selectionStart: 1, selectionEnd: 2, setSelectionRange() {} };
    }
    const event = { preventDefault: vi.fn() };
    await component.handler(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(emitted).toEqual(expectedEvents[index]);
    expect(calls).toHaveLength(1);
    adapter.dispose();
  }
});
