import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import ts from "typescript";
import { createSettingsChildBridge } from "../../packages/ztools-settings/src/childBridge";
import type {
  SettingsBridgeTarget,
  SettingsNativeInvoke,
} from "../../packages/ztools-settings/src/childBridgeTypes";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZTOOLS_ROOT = path.resolve(process.env.ATOOLS_ZTOOLS_SOURCE ?? path.join(REPO_ROOT, "..", "ZTools"));
const ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const COMPONENT = path.join(
  ZTOOLS_ROOT,
  "internal-plugins/setting/src/views/LocalLaunchSetting/LocalLaunchSetting.vue",
);
const PINNED_SFC_TOOLCHAIN = existsSync(COMPONENT)
  && existsSync(path.join(ZTOOLS_ROOT, "node_modules/.pnpm/node_modules/@vue/compiler-sfc"))
  && existsSync(path.join(ZTOOLS_ROOT, "node_modules/vue"));
const requirePinned = createRequire(path.join(ZTOOLS_ROOT, "package.json"));
const requirePinnedPackages = createRequire(path.join(ZTOOLS_ROOT, "node_modules/.pnpm/package.json"));
const previousZtools = (window as unknown as Record<string, unknown>).ztools;
let mountedApp: { mount(target: HTMLElement): unknown; unmount(): void } | undefined;
let mountedRoot: HTMLElement | undefined;

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = undefined;
  mountedRoot?.remove();
  mountedRoot = undefined;
  if (previousZtools === undefined) delete (window as unknown as Record<string, unknown>).ztools;
  else (window as unknown as Record<string, unknown>).ztools = previousZtools;
  vi.restoreAllMocks();
});

function compilePinnedLocalShortcutConsumer(options: {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  registerJump(callback: (state: { pendingFiles?: string[] }) => void): void;
}): { runtime: Record<string, any>; mount(): HTMLElement } {
  if (!existsSync(COMPONENT)) throw new Error("Pinned LocalLaunchSetting.vue is unavailable.");
  const actualCommit = execFileSync("git", ["-C", ZTOOLS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualCommit !== ZTOOLS_COMMIT) throw new Error("Original LocalLaunchSetting source is not at the pinned ZTools commit.");

  const compilerPath = requirePinnedPackages.resolve("@vue/compiler-sfc");
  const { parse, compileScript } = createRequire(compilerPath)("@vue/compiler-sfc");
  const filename = COMPONENT;
  const { descriptor, errors } = parse(readFileSync(filename, "utf8"), { filename });
  if (errors.length !== 0 || !descriptor.template || !descriptor.scriptSetup) {
    throw new Error("Pinned LocalLaunchSetting SFC could not be parsed.");
  }
  const script = compileScript(descriptor, { id: "atools-original-local-shortcuts", inlineTemplate: true });
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
      return {
        useToast: () => options,
        AdaptiveIcon: adaptiveIcon,
      };
    }
    if (specifier === "@/utils") {
      return {
        weightedSearch: (rows: unknown[]) => rows,
      };
    }
    if (specifier === "@/composables") {
      return {
        useJumpFunction: (callback: (state: { pendingFiles?: string[] }) => void) => options.registerJump(callback),
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
    ResizeObserver: undefined,
  }, { timeout: 2_000 });

  return {
    runtime,
    mount() {
      mountedRoot = document.createElement("div");
      document.body.append(mountedRoot);
      const app = runtime.createApp(module.exports.default);
      mountedApp = app;
      app.mount(mountedRoot);
      return mountedRoot;
    },
  };
}

async function settleUi(runtime: Record<string, any>): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.nextTick();
  }
}

it.skipIf(!PINNED_SFC_TOOLCHAIN)("runs original local-shortcut buttons through the child bridge and preserves cancel, edit, delete and open behavior", async () => {
  const rows = [
    { id: "keep", name: "Notes", path: "/tmp/notes.txt", type: "file", addedAt: 1 },
    { id: "stale", name: "Missing", path: "/tmp/missing", type: "folder", addedAt: 2 },
  ];
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  let jumpCallback: ((state: { pendingFiles?: string[] }) => void) | undefined;
  const success = vi.fn();
  const error = vi.fn();
  const confirmations = [false, true, true];
  const confirm = vi.fn(async () => confirmations.shift() ?? false);
  let failNextOpen = true;
  const invoke = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    calls.push({ operation, payload });
    if (operation === "readLocalShortcuts") return rows.map((row) => ({ ...row }));
    if (operation === "addLocalShortcut" && payload.type === "file") {
      return { success: false, error: "用户取消选择" };
    }
    if (operation === "addLocalShortcut") {
      rows.push({ id: "folder", name: "Folder", path: "/tmp/folder", type: "folder", addedAt: 3 });
      return { success: true };
    }
    if (operation === "addLocalShortcutByPath") {
      rows.push({ id: "pending", name: "pending.txt", path: String(payload.path), type: "file", addedAt: 4 });
      return { success: true };
    }
    if (operation === "updateLocalShortcutAlias") {
      const row = rows.find((item) => item.id === payload.id);
      if (row) {
        if (payload.alias) Object.assign(row, { alias: payload.alias });
        else delete (row as { alias?: string }).alias;
      }
      return { success: true };
    }
    if (operation === "openLocalShortcut") {
      if (failNextOpen) {
        failNextOpen = false;
        return { success: false, error: "权限拒绝" };
      }
      return { success: true };
    }
    if (operation === "deleteLocalShortcut") {
      const index = rows.findIndex((item) => item.id === payload.id);
      if (index >= 0) rows.splice(index, 1);
      return { success: true };
    }
    if (operation === "deleteMissingLocalShortcuts") {
      const index = rows.findIndex((item) => item.id === "stale");
      if (index >= 0) rows.splice(index, 1);
      return { success: true };
    }
    throw new Error(`Unexpected native local-shortcut operation: ${operation}`);
  }) as unknown as SettingsNativeInvoke;
  const target = new EventTarget() as SettingsBridgeTarget;
  const bridge = createSettingsChildBridge({
    config: {
      version: 1,
      sessionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bundleRevision: "b".repeat(64),
      platform: "darwin",
    },
    invoke,
    reportError: () => undefined,
  });
  bridge.attach(target);
  (window as unknown as Record<string, unknown>).ztools = target.ztools;
  const component = compilePinnedLocalShortcutConsumer({
    success,
    error,
    confirm,
    registerJump(callback) { jumpCallback = callback; },
  });
  const root = component.mount();
  await settleUi(component.runtime);
  expect(root.textContent).toContain("Notes");

  root.querySelector<HTMLButtonElement>("button:nth-child(1)")!.click();
  await settleUi(component.runtime);
  expect(calls).toContainEqual({ operation: "addLocalShortcut", payload: { type: "file" } });
  expect(error).not.toHaveBeenCalled();

  root.querySelector<HTMLButtonElement>("button:nth-child(2)")!.click();
  await settleUi(component.runtime);
  expect(root.textContent).toContain("Folder");
  expect(success).toHaveBeenCalledWith("添加成功");

  jumpCallback?.({ pendingFiles: [" /tmp/pending.txt ", "", "/tmp/pending.txt"] });
  await settleUi(component.runtime);
  expect(calls.filter((call) => call.operation === "addLocalShortcutByPath")).toEqual([
    { operation: "addLocalShortcutByPath", payload: { path: "/tmp/pending.txt" } },
  ]);
  expect(root.textContent).toContain("pending.txt");

  root.querySelector<HTMLButtonElement>('button[title="设置别名"]')!.click();
  await settleUi(component.runtime);
  const aliasInput = root.querySelector<HTMLInputElement>("input.alias-input")!;
  aliasInput.value = "Work notes";
  aliasInput.dispatchEvent(new Event("input", { bubbles: true }));
  aliasInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  await settleUi(component.runtime);
  expect(calls).toContainEqual({ operation: "updateLocalShortcutAlias", payload: { id: "keep", alias: "Work notes" } });
  expect(root.textContent).toContain("Work notes");

  root.querySelector<HTMLButtonElement>('button[title="修改别名"]')!.click();
  await settleUi(component.runtime);
  const clearAliasInput = root.querySelector<HTMLInputElement>("input.alias-input")!;
  clearAliasInput.value = "";
  clearAliasInput.dispatchEvent(new Event("input", { bubbles: true }));
  clearAliasInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
  await settleUi(component.runtime);
  expect(calls).toContainEqual({ operation: "updateLocalShortcutAlias", payload: { id: "keep", alias: "" } });
  expect(root.textContent).toContain("Notes");

  root.querySelector<HTMLButtonElement>('button[title="打开"]')!.click();
  await settleUi(component.runtime);
  expect(calls).toContainEqual({ operation: "openLocalShortcut", payload: { path: "/tmp/notes.txt" } });
  expect(error).toHaveBeenCalledWith("权限拒绝");
  root.querySelector<HTMLButtonElement>('button[title="打开"]')!.click();
  await settleUi(component.runtime);
  expect(calls.filter((call) => call.operation === "openLocalShortcut")).toHaveLength(2);

  root.querySelector<HTMLButtonElement>('button[title="删除"]')!.click();
  await settleUi(component.runtime);
  expect(confirm).toHaveBeenLastCalledWith({ message: '确定要删除"Notes"吗？', type: "warning" });
  expect(calls).not.toContainEqual({ operation: "deleteLocalShortcut", payload: { id: "keep" } });
  root.querySelector<HTMLButtonElement>('button[title="删除"]')!.click();
  await settleUi(component.runtime);
  expect(calls).toContainEqual({ operation: "deleteLocalShortcut", payload: { id: "keep" } });
  expect(root.textContent).not.toContain("Notes");

  root.querySelectorAll<HTMLButtonElement>("button.btn-primary")[2]!.click();
  await settleUi(component.runtime);
  expect(calls).toContainEqual({ operation: "deleteMissingLocalShortcuts", payload: {} });
  expect(root.textContent).not.toContain("Missing");

  expect(error).toHaveBeenCalledTimes(1);
  expect(calls.map((call) => call.operation)).toEqual([
    "readLocalShortcuts",
    "addLocalShortcut",
    "addLocalShortcut",
    "readLocalShortcuts",
    "addLocalShortcutByPath",
    "readLocalShortcuts",
    "updateLocalShortcutAlias",
    "updateLocalShortcutAlias",
    "openLocalShortcut",
    "openLocalShortcut",
    "deleteLocalShortcut",
    "readLocalShortcuts",
    "deleteMissingLocalShortcuts",
    "readLocalShortcuts",
  ]);
  bridge.dispose();
});
