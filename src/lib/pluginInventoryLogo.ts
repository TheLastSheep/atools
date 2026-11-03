const MAX_PATH_LENGTH = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;

export type InventoryLogoConverter = (path: string) => string;

/** Accept only host-projected local PNG paths from trusted installed package roots. */
export function validatedPluginInventoryLogoPath(
  value: unknown,
  sourceKind: unknown,
): string | null {
  if (sourceKind !== "builtin" && sourceKind !== "imported") return null;
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || value !== value.trim()) return null;
  if (CONTROL_CHARACTERS.test(value) || value.startsWith("//") || value.startsWith("\\\\")) return null;

  const windowsPath = WINDOWS_ABSOLUTE_PATH.test(value);
  const posixPath = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
  if (!windowsPath && !posixPath) return null;
  if (!/\.png$/i.test(value)) return null;

  const parts = windowsPath ? value.slice(3).split(/[\\/]/) : value.slice(1).split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  return value;
}

/** Convert a validated local path only in the desktop runtime; all failures fall back to the monogram. */
export function pluginInventoryLogoSrc(
  value: unknown,
  sourceKind: unknown,
  tauriAvailable: boolean,
  convertFileSrc: InventoryLogoConverter,
): string | null {
  const path = validatedPluginInventoryLogoPath(value, sourceKind);
  if (!path || !tauriAvailable) return null;
  try {
    const src = convertFileSrc(path);
    return typeof src === "string" && isTauriAssetUrl(src) ? src : null;
  } catch {
    return null;
  }
}

function isTauriAssetUrl(value: string): boolean {
  return /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)/i.test(value);
}
