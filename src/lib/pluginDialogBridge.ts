export type PluginDialogMethod = "showOpenDialog" | "showSaveDialog";

export function normalizeDialogBridgeOptions(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};
  return options as Record<string, unknown>;
}

export function pluginDialogSmokeGuardEnabled(
  env: Record<string, unknown> = import.meta.env as Record<string, unknown>,
): boolean {
  const value = env.VITE_ATOOLS_DESKTOP_SMOKE;
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function dialogSmokeGuardError(method: PluginDialogMethod): string {
  return `${method} skipped during desktop smoke to avoid interactive dialog UI`;
}
