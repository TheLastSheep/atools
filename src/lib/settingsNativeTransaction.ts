import type { AToolsSettings } from "./settings";
import type { SettingsPersist } from "./settingsSaveCoordinator";
import {
  cloneGeneralSettingsChanges,
  generalSettingsSnapshotFromRaw,
  readGeneralSettingsSnapshot,
  saveGeneralSettings,
  type GeneralSettingsSnapshot,
} from "./generalSettingsStore";
import { currentSettingsReadContext, refreshSettingsReadSnapshot } from "./settingsReadSession";
import { hasSettingsRuntime, writeLocalStoredSettings } from "./settingsStorage";

type NormalizeSettings = (settings: Partial<AToolsSettings> | null | undefined) => AToolsSettings;
type PersistSettings = (settings: AToolsSettings) => Promise<void>;
type SnapshotReadResult = { snapshot: GeneralSettingsSnapshot } | { error: unknown };

/** Bind an editor writer to its opening Native or preview snapshot. */
export function createSettingsWriter(
  normalizeSettings: NormalizeSettings,
): SettingsPersist {
  const nativeRuntime = hasSettingsRuntime();
  const lease = currentSettingsReadContext();
  if (nativeRuntime && !lease) {
    return async () => {
      throw new Error("Settings editor has no opening Native settings snapshot; reopen settings before saving");
    };
  }

  let snapshot: GeneralSettingsSnapshot | null = lease?.snapshot ?? null;
  let savedSettings: AToolsSettings | null = lease ? cloneSettings(lease.settings) : null;
  const openingSnapshot = lease
    ? Promise.resolve<SnapshotReadResult>({ snapshot: lease.snapshot })
    : readGeneralSettingsSnapshot().then(
      value => ({ snapshot: value }) as SnapshotReadResult,
      error => ({ error }) as SnapshotReadResult,
    );

  return async (next, previous) => {
    const safeNext = cloneSettingsRecord(next);
    const safePrevious = cloneSettingsRecord(previous);
    if (savedSettings && !sameSettings(safePrevious, savedSettings)) {
      throw new Error("Settings editing session was superseded; reopen settings before saving");
    }

    if (!snapshot) {
      const opening = await openingSnapshot;
      if ("error" in opening) throw opening.error;
      snapshot = opening.snapshot;
      const baseline = normalizeSettings(snapshot.value as Partial<AToolsSettings>);
      if (!sameKnownSettings(
        safePrevious,
        baseline,
        settingsComparisonKeys(safePrevious, normalizeSettings),
      )) {
        throw new Error("Settings changed since this editor was opened; reload before saving");
      }
      savedSettings = cloneSettings(baseline);
    }

    const capturedSnapshot = snapshot;
    if (!capturedSnapshot) throw new Error("Settings editor has no captured settings snapshot; reopen settings before saving");
    const changes = nativeRuntime
      ? omitNativeRuntimeOwnedSettings(safeNext, safePrevious)
      : next;
    const receipt = await saveGeneralSettings(capturedSnapshot, changes, { applyNative: nativeRuntime });
    const committed = generalSettingsSnapshotFromRaw(receipt.raw);
    snapshot = committed;
    savedSettings = cloneSettings(safeNext);
    if (lease && refreshSettingsReadSnapshot(lease.request, safeNext, committed)) {
      if (nativeRuntime) writeLocalStoredSettings(receipt.raw);
    }
  };
}

/** Keep native state and persisted settings on the same snapshot. */
export async function applySettingsTransaction(
  next: AToolsSettings,
  previous: AToolsSettings,
  persistSettings: PersistSettings,
  normalizeSettings: NormalizeSettings,
): Promise<void> {
  if (!hasSettingsRuntime()) {
    await persistSettings(next);
    return;
  }

  const safeNext = cloneSettingsRecord(next);
  const safePrevious = cloneSettingsRecord(previous);
  const lease = currentSettingsReadContext();
  if (lease && !sameSettings(safePrevious, lease.settings)) {
    throw new Error("Settings editing session was superseded; reopen settings before saving");
  }
  const snapshot = lease?.snapshot ?? await readGeneralSettingsSnapshot();
  if (!lease && !sameKnownSettings(
    safePrevious,
    normalizeSettings(snapshot.value as Partial<AToolsSettings>),
    settingsComparisonKeys(safePrevious, normalizeSettings),
  )) {
    throw new Error("Native settings changed since this edit was opened; reopen settings before saving");
  }
  const changes = omitNativeRuntimeOwnedSettings(safeNext, safePrevious);
  const receipt = await saveGeneralSettings(snapshot, changes, { applyNative: true });
  if (lease) {
    const committed = generalSettingsSnapshotFromRaw(receipt.raw);
    if (refreshSettingsReadSnapshot(lease.request, safeNext, committed)) {
      writeLocalStoredSettings(receipt.raw);
    }
  } else if (!currentSettingsReadContext()) {
    writeLocalStoredSettings(receipt.raw);
  }
}

function cloneSettingsRecord(settings: AToolsSettings): AToolsSettings {
  return cloneGeneralSettingsChanges(settings) as unknown as AToolsSettings;
}

/** Keep OS-owned state out of Native form patches; preview keeps the full form. */
function omitNativeRuntimeOwnedSettings(
  next: AToolsSettings,
  previous: AToolsSettings,
): Record<string, unknown> {
  const changes: Record<string, unknown> = Object.assign(Object.create(null), next);
  delete changes.launchAtLogin;
  if (changes.hotkey === previous.hotkey) delete changes.hotkey;
  // Preserve out-of-range stored heights while the editor leaves its normalized projection unchanged.
  if (changes.windowDefaultHeight === previous.windowDefaultHeight) delete changes.windowDefaultHeight;
  return changes;
}

function cloneSettings(settings: AToolsSettings): AToolsSettings {
  return JSON.parse(JSON.stringify(settings)) as AToolsSettings;
}

function sameKnownSettings(left: unknown, right: unknown, keys: string[]): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return keys.every(key => sameSettings(a[key], b[key]));
}

function settingsComparisonKeys(
  previous: unknown,
  normalizeSettings: NormalizeSettings,
): string[] {
  const previousKeys = previous && typeof previous === "object" ? Object.keys(previous) : [];
  return [...new Set([...Object.keys(normalizeSettings(undefined)), ...previousKeys])];
}

function sameSettings(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameSettings(value, right[index]));
  }
  const a = Object.keys(left as object).sort();
  const b = Object.keys(right as object).sort();
  if (a.length !== b.length || a.some((key, index) => key !== b[index])) return false;
  return a.every(key => sameSettings((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

