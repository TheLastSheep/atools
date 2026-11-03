import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parseSettingsJson } from "../../packages/ztools-renderer/src/mappers";
import { withBuiltinShortcutPreferences } from "../../packages/ztools-renderer/src/builtinAppShortcuts";
import { createStartupReadModel } from "../../packages/ztools-renderer/src/startupReadModel";
import { createRendererGeneralPreferenceEvents } from "../../packages/ztools-renderer/src/generalPreferenceEvents";
import { applyReviewedRendererCompatibilityPatch } from "../../packages/ztools-renderer/upstream-compatibility-patches.mjs";
import type { RendererHostListener } from "../../packages/ztools-renderer/src/types";
import { HOST_ERROR_CODES } from "../../packages/ztools-renderer/src/errors";

const previousZtools = (window as any).ztools;
afterEach(() => { (window as any).ztools = previousZtools; });

function preferencesFixture() {
  let listener: RendererHostListener | undefined;
  const stop = vi.fn();
  const preferences = createRendererGeneralPreferenceEvents({
    listen: vi.fn(async (_event, callback) => { listener = callback; return stop; }),
  });
  return {
    preferences, stop,
    emit(config: unknown) {
      listener?.({ version: 1, raw: JSON.stringify({ builtinAppShortcutsEnabled: config }) });
    },
  };
}

function actualStore(api: Record<string, unknown>) {
  const path = "src/renderer/src/stores/windowStore.ts";
  const original = readFileSync(`/Users/harris/Desktop/ZTools/${path}`, "utf8");
  const patched = applyReviewedRendererCompatibilityPatch(path, original);
  expect(patched).not.toBeNull();
  const source = ts.transpileModule(patched!.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const cleanups: Array<() => void> = [];
  const exports: Record<string, any> = {};
  (window as any).ztools = api;
  window.matchMedia = vi.fn(() => ({ addEventListener: vi.fn() })) as any;
  new Function("require", "exports", source)((specifier: string) => {
    if (specifier === "pinia") return { defineStore: (_id: string, setup: () => unknown) => setup };
    if (specifier === "vue") return {
      ref: (value: unknown) => ({ value }), computed: (read: () => unknown) => ({ get value() { return read(); } }),
      onScopeDispose: (cleanup: () => void) => cleanups.push(cleanup),
    };
    if (specifier.endsWith("default.png")) return { default: "/fixture-avatar.png" };
    throw new Error(`Unexpected original Store import: ${specifier}`);
  }, exports);
  return { store: exports.useWindowStore(), dispose: () => cleanups.forEach((cleanup) => cleanup()) };
}

describe("original built-in shortcut settings in Main", () => {
  it("keeps absent General null and projects only search/esc/closePlugin with explicit defaults", () => {
    expect(parseSettingsJson(null)).toBeNull();
    for (const config of [undefined, null, false, [], "invalid", 1]) {
      const raw = JSON.stringify({ builtinAppShortcutsEnabled: config });
      expect(parseSettingsJson(raw)).toEqual({ builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true } });
    }
    for (const closePlugin of [undefined, null, "false", 0, true]) {
      expect(parseSettingsJson(JSON.stringify({ builtinAppShortcutsEnabled: { search: false, esc: false, closePlugin } })))
        .toEqual({ builtinAppShortcutsEnabled: { search: false, esc: false, closePlugin: true } });
    }
    expect(parseSettingsJson(JSON.stringify({ builtinAppShortcutsEnabled: {
      search: false, esc: false, closePlugin: false, killPlugin: false, privateUnknown: "secret",
    } }))).toEqual({ builtinAppShortcutsEnabled: { search: false, esc: false, closePlugin: false } });
  });

  it("uses accepted events over pending and cached reads, with fresh values and disposal", async () => {
    const fixture = preferencesFixture();
    let resolve!: (raw: string) => void;
    const pendingRaw = new Promise<string>((done) => { resolve = done; });
    const load = vi.fn(() => pendingRaw);
    const model = withBuiltinShortcutPreferences(createStartupReadModel(load, async () => { throw new Error("Unexpected fallback"); }), fixture.preferences);
    await fixture.preferences.ready();
    const pending = model.dbGet("settings-general");
    fixture.emit({ search: false, esc: false, closePlugin: false });
    resolve('{"theme":"dark","builtinAppShortcutsEnabled":{"search":true,"esc":true,"closePlugin":true}}');
    expect(await pending).toEqual({ theme: "dark", builtinAppShortcutsEnabled: { search: false, esc: false, closePlugin: false } });
    const cached = await model.dbGet("settings-general") as any;
    cached.builtinAppShortcutsEnabled.search = true;
    cached.builtinAppShortcutsEnabled.closePlugin = true;
    expect(await model.dbGet("settings-general")).toMatchObject({ builtinAppShortcutsEnabled: { search: false, esc: false, closePlugin: false } });
    fixture.emit({ search: true, esc: false, closePlugin: true });
    expect(await model.dbGet("settings-general")).toMatchObject({ builtinAppShortcutsEnabled: { search: true, esc: false, closePlugin: true } });
    expect(load).toHaveBeenCalledTimes(1);
    model.dispose();
    fixture.preferences.dispose();
    await expect(model.dbGet("settings-general")).rejects.toMatchObject({ code: HOST_ERROR_CODES.DISPOSED });
    expect(fixture.stop).toHaveBeenCalledTimes(1);
  });

  it("replays immutable latest flags for late consumers and rejects malformed event DTOs", async () => {
    const fixture = preferencesFixture();
    const first = vi.fn((value) => { value.search = true; });
    fixture.preferences.subscribe("onUpdateBuiltinAppShortcutsEnabled", first);
    await fixture.preferences.ready();
    fixture.emit({ search: false, esc: true, closePlugin: false });
    const late = vi.fn();
    fixture.preferences.subscribe("onUpdateBuiltinAppShortcutsEnabled", late);
    expect(late).toHaveBeenLastCalledWith({ search: false, esc: true, closePlugin: false });
    for (const invalid of [{ search: false }, { search: 1, esc: true }, { search: false, esc: true, secret: "private" }]) {
      fixture.emit(invalid);
    }
    expect(late).toHaveBeenCalledTimes(1);
    expect(fixture.preferences.snapshot().invalidPayloads).toBe(3);
    fixture.preferences.dispose();
  });

  it("updates the actual original Store immediately and rejects a late cold-read overwrite", async () => {
    let update!: (value: { search: boolean; esc: boolean; closePlugin: boolean }) => void;
    let resolve!: (value: unknown) => void;
    const stop = vi.fn();
    const fixture = actualStore({
      onUpdateBuiltinAppShortcutsEnabled(callback: typeof update) { update = callback; return stop; },
      dbGet: () => new Promise((done) => { resolve = done; }),
    });
    const pending = fixture.store.loadSettings();
    update({ search: false, esc: false, closePlugin: false });
    expect(fixture.store.builtInSearchShortcutEnabled.value).toBe(false);
    expect(fixture.store.builtInEscShortcutEnabled.value).toBe(false);
    resolve({ builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true } });
    await pending;
    expect(fixture.store.builtInSearchShortcutEnabled.value).toBe(false);
    expect(fixture.store.builtInEscShortcutEnabled.value).toBe(false);
    update({ search: true, esc: true, closePlugin: true });
    expect(fixture.store.builtInSearchShortcutEnabled.value).toBe(true);
    expect(fixture.store.builtInEscShortcutEnabled.value).toBe(true);
    fixture.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps an event arriving after a read has resolved but before the Store await continuation", async () => {
    const fixture = preferencesFixture();
    const model = withBuiltinShortcutPreferences(createStartupReadModel(
      async () => '{"builtinAppShortcutsEnabled":{"search":true,"esc":true,"closePlugin":true}}', async () => { throw new Error("Unexpected fallback"); },
    ), fixture.preferences);
    await fixture.preferences.ready();
    // The original read-model cache now contains a fulfilled Promise with the old flags.
    await model.dbGet("settings-general");
    const original = actualStore({
      dbGet: model.dbGet,
      onUpdateBuiltinAppShortcutsEnabled: (callback: any) => fixture.preferences.subscribe("onUpdateBuiltinAppShortcutsEnabled", callback),
    });
    const pending = original.store.loadSettings();
    fixture.emit({ search: false, esc: false, closePlugin: false });
    await pending;
    expect(original.store.builtInSearchShortcutEnabled.value).toBe(false);
    expect(original.store.builtInEscShortcutEnabled.value).toBe(false);
    original.dispose();
    model.dispose();
    fixture.preferences.dispose();
  });
});
