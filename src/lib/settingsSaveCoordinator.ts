import type { AToolsSettings } from "./settings";

const MAX_PENDING_SETTINGS_SAVES = 32;

export type SettingsPersist = (
  next: AToolsSettings,
  previous: AToolsSettings,
) => Promise<void>;

export class SettingsSaveCoordinator {
  private savedSettings: AToolsSettings;
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  constructor(
    initialSettings: AToolsSettings,
    private readonly persist: SettingsPersist,
  ) {
    this.savedSettings = cloneSettings(initialSettings);
  }

  enqueue(next: AToolsSettings): Promise<void> {
    if (this.pendingCount >= MAX_PENDING_SETTINGS_SAVES) {
      return Promise.reject(new Error(`Settings save queue is full (${MAX_PENDING_SETTINGS_SAVES} pending saves maximum)`));
    }
    const snapshot = cloneSettings(next);
    this.pendingCount += 1;
    const operation = this.queue.then(async () => {
      const previous = cloneSettings(this.savedSettings);
      await this.persist(cloneSettings(snapshot), previous);
      this.savedSettings = cloneSettings(snapshot);
    });
    const settled = operation.finally(() => {
      this.pendingCount -= 1;
    });
    this.queue = settled.catch(() => {});
    return settled;
  }

  lastSaved(): AToolsSettings {
    return cloneSettings(this.savedSettings);
  }

  hydrate(settings: AToolsSettings): void {
    this.savedSettings = cloneSettings(settings);
  }
}

function cloneSettings(settings: AToolsSettings): AToolsSettings {
  // Settings are JSON records; round-tripping preserves unknown fields and detaches nested values.
  return JSON.parse(JSON.stringify(settings)) as AToolsSettings;
}

export type DebouncedSettingsEnqueue = (
  settings: AToolsSettings,
  revision: number,
) => Promise<void>;

export class SettingsSaveDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { settings: AToolsSettings; revision: number } | null = null;

  constructor(
    private readonly enqueue: DebouncedSettingsEnqueue,
    private readonly delayMs = 160,
  ) {}

  schedule(settings: AToolsSettings, revision: number): void {
    this.pending = { settings, revision };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  discard(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  flush(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!pending) return Promise.resolve();

    try {
      return this.enqueue(pending.settings, pending.revision).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }
}
