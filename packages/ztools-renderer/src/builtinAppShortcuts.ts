import type { RendererGeneralPreferenceEvents } from "./generalPreferenceEvents";
import type { StartupReadModel } from "./startupReadModel";
import { adapterDisposedError } from "./errors";

export interface RendererBuiltinAppShortcuts {
  search: boolean;
  esc: boolean;
  closePlugin: boolean;
}

/** Only explicit false disables a supported built-in shortcut. */
export function projectBuiltinAppShortcuts(value: unknown): RendererBuiltinAppShortcuts {
  const config = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return { search: config.search !== false, esc: config.esc !== false, closePlugin: config.closePlugin !== false };
}

export function isBuiltinAppShortcuts(value: unknown): value is RendererBuiltinAppShortcuts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return Object.keys(config).length === 3 && Object.hasOwn(config, "search")
    && Object.hasOwn(config, "esc") && Object.hasOwn(config, "closePlugin")
    && typeof config.search === "boolean" && typeof config.esc === "boolean" && typeof config.closePlugin === "boolean";
}

/** An accepted event stays authoritative over cached or late startup reads. */
export function withBuiltinShortcutPreferences(
  readModel: StartupReadModel,
  preferences: Pick<RendererGeneralPreferenceEvents, "subscribe">,
): StartupReadModel {
  let latest: Readonly<RendererBuiltinAppShortcuts> | undefined;
  let disposed = false;
  const stop = preferences.subscribe("onUpdateBuiltinAppShortcutsEnabled", (value) => {
    latest = { ...value };
  });
  return {
    ...readModel,
    async dbGet(key) {
      if (disposed) throw adapterDisposedError();
      const value = await readModel.dbGet(key);
      if (disposed) throw adapterDisposedError();
      return key === "settings-general" && latest
        ? { ...(value as Record<string, unknown> | null), builtinAppShortcutsEnabled: { ...latest } }
        : value;
    },
    dispose() {
      disposed = true;
      stop();
      latest = undefined;
      readModel.dispose();
    },
  };
}
