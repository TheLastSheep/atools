import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  settingsSourceCompatibilityPatches,
} from "../../packages/ztools-settings/src/compatibility-patches/index.mjs";
import {
  applySettingsSourceCompatibility,
} from "../../packages/ztools-settings/src/source-compatibility.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SETTINGS_ROOT = path.join(REPO_ROOT, "packages/ztools-settings");
const ZTOOLS_ROOT = path.resolve(process.env.ATOOLS_ZTOOLS_SOURCE ?? path.join(REPO_ROOT, "..", "ZTools"));
const ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const RELATIVE_SFC = "internal-plugins/setting/src/views/LocalLaunchSetting/LocalLaunchSetting.vue";
const UPSTREAM_SFC = path.join(ZTOOLS_ROOT, RELATIVE_SFC);
const PINNED_SFC_TOOLCHAIN = existsSync(UPSTREAM_SFC)
  && existsSync(path.join(ZTOOLS_ROOT, "node_modules/.pnpm/node_modules/@vue/compiler-sfc"))
  && existsSync(path.join(ZTOOLS_ROOT, "node_modules/vue"));
const requirePinned = createRequire(path.join(ZTOOLS_ROOT, "package.json"));
const requirePinnedPackages = createRequire(path.join(ZTOOLS_ROOT, "node_modules/.pnpm/package.json"));
const compilerPath = requirePinnedPackages.resolve("@vue/compiler-sfc");
const { parse, compileScript } = createRequire(compilerPath)("@vue/compiler-sfc");
const stageParents: string[] = [];
let mountedApp: { unmount(): void } | undefined;
let mountedRoot: HTMLElement | undefined;
let previousHash = "";
let previousZtools: unknown;

afterEach(async () => {
  mountedApp?.unmount();
  mountedApp = undefined;
  mountedRoot?.remove();
  mountedRoot = undefined;
  for (const parent of stageParents.splice(0)) await rm(parent, { recursive: true, force: true });
  window.history.replaceState(null, "", `/tests/components/ztools-settings-original-local-shortcuts-native-drop.test.ts${previousHash}`);
  if (previousZtools === undefined) delete (window as unknown as Record<string, unknown>).ztools;
  else (window as unknown as Record<string, unknown>).ztools = previousZtools;
  vi.restoreAllMocks();
});

async function createStagedUpstream(mutateTarget?: (source: string) => string): Promise<{
  parent: string;
  upstream: string;
  originalSource: string;
}> {
  if (!PINNED_SFC_TOOLCHAIN) throw new Error("Pinned ZTools LocalLaunchSetting source/toolchain is unavailable.");
  const actualCommit = execFileSync("git", ["-C", ZTOOLS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualCommit !== ZTOOLS_COMMIT) throw new Error("Original LocalLaunchSetting source is not at the pinned ZTools commit.");

  const parent = await mkdtemp(path.join(SETTINGS_ROOT, ".ztools-settings-build-native-drop-"));
  stageParents.push(parent);
  const upstream = path.join(parent, "upstream");
  await mkdir(upstream, { recursive: true });
  const files = new Set([
    ...settingsSourceCompatibilityPatches.map((patch) => patch.path),
    RELATIVE_SFC,
  ]);
  let originalSource = "";
  for (const relative of files) {
    const sourcePath = path.join(ZTOOLS_ROOT, relative);
    let bytes = await readFile(sourcePath);
    if (relative === RELATIVE_SFC) {
      originalSource = bytes.toString("utf8");
      if (mutateTarget) bytes = Buffer.from(mutateTarget(originalSource), "utf8");
    }
    const targetPath = path.join(upstream, relative);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes, { mode: 0o644 });
  }
  return { parent, upstream, originalSource };
}

function compilePatchedSfc(source: string): { runtime: Record<string, any>; component: unknown } {
  const { descriptor, errors } = parse(source, { filename: UPSTREAM_SFC });
  if (errors.length > 0 || !descriptor.template || !descriptor.scriptSetup) {
    throw new Error("Patched pinned LocalLaunchSetting SFC could not be parsed.");
  }
  const script = compileScript(descriptor, { id: "atools-original-local-shortcuts-native-drop", inlineTemplate: true });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const runtime = requirePinned("vue") as Record<string, any>;
  const adaptiveIcon = { name: "AdaptiveIcon", render: () => null };
  const requireModule = (specifier: string): unknown => {
    if (specifier === "vue") return runtime;
    if (specifier === "@/components") {
      return { useToast: () => ({ success: toastSuccess, error: toastError, confirm: vi.fn() }), AdaptiveIcon: adaptiveIcon };
    }
    if (specifier === "@/utils") return { weightedSearch: (rows: unknown[]) => rows };
    if (specifier === "@/composables") {
      return {
        useJumpFunction: () => undefined,
        useZtoolsSubInput: (value: string) => ({ value: runtime.ref(value) }),
      };
    }
    if (specifier === "@/views/LocalLaunchSetting/LocalLaunchSetting") {
      return { LocalLaunchSettingJumpFunction: class LocalLaunchSettingJumpFunction {} };
    }
    throw new Error(`Unexpected pinned LocalLaunchSetting dependency: ${specifier}`);
  };
  const module = { exports: {} as Record<string, any> };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: requireModule,
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    ResizeObserver: undefined,
  }, { timeout: 2_000 });
  return { runtime, component: module.exports.default };
}

let toastSuccess: ReturnType<typeof vi.fn>;
let toastError: ReturnType<typeof vi.fn>;

async function settleUi(runtime: Record<string, any>): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.nextTick();
  }
}

function nativeDropEvent(
  phase: "enter" | "leave" | "result",
  fields: Partial<{ added: number; failed: number; busy: boolean; rejected: boolean }> = {},
): Record<string, unknown> {
  return {
    version: 1,
    sessionId: "a".repeat(32),
    revision: 1,
    phase,
    added: fields.added ?? 0,
    failed: fields.failed ?? 0,
    busy: fields.busy ?? false,
    rejected: fields.rejected ?? false,
  };
}

it("applies the pinned native-drop patch and drives the original view without repeating path writes", async () => {
  previousHash = window.location.hash;
  previousZtools = (window as unknown as Record<string, unknown>).ztools;
  const staged = await createStagedUpstream();
  const result = await applySettingsSourceCompatibility(staged.upstream);
  const patchedEntry = result.patchedFiles.find((file) => file.path === RELATIVE_SFC);
  expect(patchedEntry).toBeDefined();
  expect(patchedEntry?.templateUnchanged).toBe(true);
  expect(patchedEntry?.stylesUnchanged).toBe(true);
  expect(patchedEntry?.changes.map((change) => change.id)).toEqual([
    "local-shortcut-native-drop-lifecycle",
    "local-shortcut-native-drop-handler",
  ]);

  const patchedSource = await readFile(path.join(staged.upstream, RELATIVE_SFC), "utf8");
  expect(patchedSource).toContain("window.ztools.internal.localShortcuts.addByPath(filePath)");
  expect(patchedSource).toContain('@drop.prevent="handleDrop"');
  expect(patchedSource).toContain("internal.onNativeLocalDrop((event) => {");
  expect(patchedSource).not.toContain("event.paths");

  const { runtime, component } = compilePatchedSfc(patchedSource);
  const callbacks: Array<(event: Record<string, unknown>) => void> = [];
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const getAll = vi.fn(async () => [{ id: "keep", name: "Notes", path: "/tmp/notes.txt", type: "file", addedAt: 1 }]);
  const addByPath = vi.fn(async () => ({ success: true }));
  const onNativeLocalDrop = vi.fn((callback: (event: Record<string, unknown>) => void) => {
    callbacks.push(callback);
    const unsubscribe = vi.fn();
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  const ztools = {
    internal: {
      onNativeLocalDrop,
      localShortcuts: {
        getAll,
        addByPath,
      },
    },
    getPathForFile: vi.fn(() => "/tmp/legacy.txt"),
  };
  (window as unknown as Record<string, unknown>).ztools = ztools;
  toastSuccess = vi.fn();
  toastError = vi.fn();
  window.history.replaceState(null, "", "/settings#/localLaunch");

  mountedRoot = document.createElement("div");
  document.body.append(mountedRoot);
  const app = runtime.createApp(component);
  mountedApp = app;
  app.mount(mountedRoot);
  await settleUi(runtime);
  expect(onNativeLocalDrop).toHaveBeenCalledTimes(1);
  expect(getAll).toHaveBeenCalledTimes(1);
  expect(mountedRoot.textContent).toContain("Notes");

  callbacks[0](nativeDropEvent("enter"));
  await settleUi(runtime);
  expect(mountedRoot.querySelector(".drag-overlay")).not.toBeNull();

  callbacks[0](nativeDropEvent("leave"));
  await settleUi(runtime);
  expect(mountedRoot.querySelector(".drag-overlay")).toBeNull();

  callbacks[0](nativeDropEvent("enter"));
  await settleUi(runtime);
  expect(mountedRoot.querySelector(".drag-overlay")).not.toBeNull();

  callbacks[0](nativeDropEvent("result", { added: 1 }));
  await settleUi(runtime);
  expect(mountedRoot.querySelector(".drag-overlay")).not.toBeNull();
  expect(toastSuccess).toHaveBeenCalledWith("添加成功");
  expect(getAll).toHaveBeenCalledTimes(2);

  callbacks[0](nativeDropEvent("leave"));
  await settleUi(runtime);
  expect(mountedRoot.querySelector(".drag-overlay")).toBeNull();

  callbacks[0](nativeDropEvent("result", { added: 1, failed: 1, rejected: true }));
  await settleUi(runtime);
  expect(toastSuccess).toHaveBeenCalledTimes(2);
  expect(toastError).toHaveBeenCalledWith("添加失败");
  expect(getAll).toHaveBeenCalledTimes(3);

  callbacks[0](nativeDropEvent("result", { busy: true }));
  await settleUi(runtime);
  expect(toastError).toHaveBeenCalledWith("上一批处理中，请稍后再试");
  expect(getAll).toHaveBeenCalledTimes(3);
  expect(addByPath).not.toHaveBeenCalled();

  window.history.replaceState(null, "", "/settings#/general?_t=2");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await settleUi(runtime);
  expect(unsubscribers[0]).toHaveBeenCalledTimes(1);
  expect(onNativeLocalDrop).toHaveBeenCalledTimes(1);

  window.history.replaceState(null, "", "/settings#/localLaunch?_t=3");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await settleUi(runtime);
  expect(onNativeLocalDrop).toHaveBeenCalledTimes(2);

  for (const hash of [
    "#/localLaunch?_t=0",
    "#/localLaunch?_t=01",
    "#/localLaunch?_t=2&extra=3",
    "#/localLaunch?%5Ft=2",
    "#/localLaunch?_t=%32",
    "#/localLaunch?_t=2&_t=3",
    "#/localLaunch?_t=9007199254740992",
    "#/localLaunch?_t=12345678901234567",
  ]) {
    window.history.replaceState(null, "", `/settings${hash}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settleUi(runtime);
  }
  expect(unsubscribers[1]).toHaveBeenCalledTimes(1);
  expect(onNativeLocalDrop).toHaveBeenCalledTimes(2);

  window.history.replaceState(null, "", "/settings#/localLaunch?_t=9007199254740991");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await settleUi(runtime);
  expect(onNativeLocalDrop).toHaveBeenCalledTimes(3);

  app.unmount();
  mountedApp = undefined;
  expect(unsubscribers[2]).toHaveBeenCalledTimes(1);
  callbacks[2](nativeDropEvent("result", { added: 1 }));
  await settleUi(runtime);
  expect(toastSuccess).toHaveBeenCalledTimes(2);
  expect(getAll).toHaveBeenCalledTimes(3);
  expect(addByPath).not.toHaveBeenCalled();
});

it("rejects source drift before writing and keeps protected blocks byte-identical", async () => {
  const staged = await createStagedUpstream((source) => `${source}\n// drift`);
  const firstPatchPath = settingsSourceCompatibilityPatches[0].path;
  const firstPatchBefore = await readFile(path.join(ZTOOLS_ROOT, firstPatchPath));
  await expect(applySettingsSourceCompatibility(staged.upstream)).rejects.toThrow(
    `${RELATIVE_SFC}: source hash mismatch`,
  );
  expect(await readFile(path.join(staged.upstream, RELATIVE_SFC), "utf8")).toBe(`${staged.originalSource}\n// drift`);
  expect(await readFile(path.join(staged.upstream, firstPatchPath))).toEqual(firstPatchBefore);
});
