type DesktopSmokePluginActionIdentity = {
  plugin_id?: unknown;
  feature_code?: unknown;
  plugin_path?: unknown;
  main_url?: unknown;
};

const DESKTOP_SMOKE_PLUGIN_ACTION_IDENTITY_FIELDS = [
  "plugin_id",
  "feature_code",
  "plugin_path",
  "main_url",
] as const;

export function desktopSmokePluginQueueActionActive(
  smokeEnabled: boolean,
  activeAction: DesktopSmokePluginActionIdentity | null | undefined,
  queue: readonly DesktopSmokePluginActionIdentity[],
  queueIndex: number,
) {
  if (!smokeEnabled || !activeAction || queue.length === 0) return false;
  if (!Number.isSafeInteger(queueIndex) || queueIndex < 0 || queueIndex >= queue.length) return false;
  const queuedAction = queue[queueIndex];
  if (!queuedAction) return false;
  if (queuedAction === activeAction) return true;
  return DESKTOP_SMOKE_PLUGIN_ACTION_IDENTITY_FIELDS.every((field) => {
    const queuedValue = queuedAction[field];
    const activeValue = activeAction[field];
    return typeof queuedValue === "string"
      && queuedValue.length > 0
      && activeValue === queuedValue;
  });
}
