export type TrackedSettingKey = "command-aliases" | "disable-commands" | "local-shortcuts";
export type SettingsGeneration = readonly [number, number, number];

const NAMESPACE_PREFIX = "ztools-renderer:";

function trackedIndex(key: string): number {
  const setting = key.startsWith(NAMESPACE_PREFIX) ? key.slice(NAMESPACE_PREFIX.length) : key;
  return setting === "command-aliases" ? 0
    : setting === "disable-commands" ? 1
      : setting === "local-shortcuts" ? 2 : -1;
}

/** Captured tuples stay immutable so caches can test only the key they read. */
export function createSettingsGenerations() {
  let current: SettingsGeneration = [0, 0, 0];
  return {
    capture: () => current,
    isCurrent(key: string, captured?: SettingsGeneration) {
      if (!captured) return true;
      const index = trackedIndex(key);
      return index < 0 || current[index] === captured[index];
    },
    invalidate(key: TrackedSettingKey) {
      const index = key === "command-aliases" ? 0
        : key === "disable-commands" ? 1 : 2;
      const next: [number, number, number] = [...current];
      next[index] += 1;
      current = next;
    },
  };
}

export type SettingsGenerations = ReturnType<typeof createSettingsGenerations>;
