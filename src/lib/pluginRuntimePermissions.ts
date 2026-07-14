export type PluginRuntimePermissionGrantStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PluginRuntimePermissionGrantMap = Record<string, string[]>;
export type PluginRuntimePermissionGrantsUpdatedDetail = {
  pluginId: string;
  permissions: string[];
  grants: PluginRuntimePermissionGrantMap;
};

export const PLUGIN_RUNTIME_PERMISSION_GRANTS_STORAGE_KEY = "atools.pluginRuntimePermissionGrants.v1";
export const PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT = "atools-plugin-runtime-permission-grants-updated";

function defaultPluginRuntimePermissionStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function pluginRuntimePermissionStorage(storage?: PluginRuntimePermissionGrantStorage | null) {
  return storage ?? defaultPluginRuntimePermissionStorage();
}

export function normalizePluginRuntimePluginId(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizePluginRuntimePermission(value: unknown) {
  return String(value ?? "").trim();
}

function normalizePluginRuntimePermissionList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const permissions: string[] = [];
  for (const item of value) {
    const permission = normalizePluginRuntimePermission(item);
    if (!permission || seen.has(permission)) continue;
    seen.add(permission);
    permissions.push(permission);
  }
  return permissions;
}

function normalizePluginRuntimePermissionGrantMap(value: unknown): PluginRuntimePermissionGrantMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const grants: PluginRuntimePermissionGrantMap = {};
  for (const [rawPluginId, rawPermissions] of Object.entries(value as Record<string, unknown>)) {
    const pluginId = normalizePluginRuntimePluginId(rawPluginId);
    const permissions = normalizePluginRuntimePermissionList(rawPermissions);
    if (!pluginId || permissions.length === 0) continue;
    grants[pluginId] = permissions;
  }
  return grants;
}

export function loadPluginRuntimePermissionGrants(
  storage?: PluginRuntimePermissionGrantStorage | null,
): PluginRuntimePermissionGrantMap {
  const targetStorage = pluginRuntimePermissionStorage(storage);
  if (!targetStorage) return {};
  try {
    const value = targetStorage.getItem(PLUGIN_RUNTIME_PERMISSION_GRANTS_STORAGE_KEY);
    return normalizePluginRuntimePermissionGrantMap(value ? JSON.parse(value) : {});
  } catch {
    return {};
  }
}

function savePluginRuntimePermissionGrants(
  grants: PluginRuntimePermissionGrantMap,
  storage?: PluginRuntimePermissionGrantStorage | null,
) {
  const targetStorage = pluginRuntimePermissionStorage(storage);
  if (!targetStorage) return false;
  const normalized = normalizePluginRuntimePermissionGrantMap(grants);
  try {
    if (Object.keys(normalized).length === 0) {
      targetStorage.removeItem(PLUGIN_RUNTIME_PERMISSION_GRANTS_STORAGE_KEY);
    } else {
      targetStorage.setItem(PLUGIN_RUNTIME_PERMISSION_GRANTS_STORAGE_KEY, JSON.stringify(normalized));
    }
    return true;
  } catch {
    return false;
  }
}

function dispatchPluginRuntimePermissionGrantsUpdated(
  pluginId: string,
  grants: PluginRuntimePermissionGrantMap,
) {
  if (typeof window === "undefined") return;
  const normalizedPluginId = normalizePluginRuntimePluginId(pluginId);
  const normalizedGrants = normalizePluginRuntimePermissionGrantMap(grants);
  const detail: PluginRuntimePermissionGrantsUpdatedDetail = {
    pluginId: normalizedPluginId,
    permissions: normalizedPluginId ? (normalizedGrants[normalizedPluginId] ?? []) : [],
    grants: normalizedGrants,
  };
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent<PluginRuntimePermissionGrantsUpdatedDetail>(
      PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT,
      { detail },
    ));
    return;
  }
  window.dispatchEvent({ type: PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, detail } as unknown as Event);
}

export function pluginRuntimePermissionGrantList(
  pluginId: unknown,
  storage?: PluginRuntimePermissionGrantStorage | null,
) {
  const normalizedPluginId = normalizePluginRuntimePluginId(pluginId);
  if (!normalizedPluginId) return [];
  return loadPluginRuntimePermissionGrants(storage)[normalizedPluginId] ?? [];
}

function pluginRuntimePermissionGroup(permission: string) {
  const index = permission.indexOf(".");
  return index > 0 ? permission.slice(0, index) : permission;
}

function pluginRuntimePermissionListAllows(permissions: string[], permission: string) {
  const value = normalizePluginRuntimePermission(permission);
  if (!value) return true;
  const group = pluginRuntimePermissionGroup(value);
  return permissions.some((item) => {
    const allowed = normalizePluginRuntimePermission(item);
    if (!allowed) return false;
    if (allowed === "*" || allowed === value || allowed === group) return true;
    if (allowed.endsWith(".*") && value.startsWith(allowed.slice(0, -1))) return true;
    return false;
  });
}

export function isPluginRuntimePermissionPersistentlyGranted(
  pluginId: unknown,
  permission: unknown,
  storage?: PluginRuntimePermissionGrantStorage | null,
) {
  return pluginRuntimePermissionListAllows(
    pluginRuntimePermissionGrantList(pluginId, storage),
    normalizePluginRuntimePermission(permission),
  );
}

export function grantPluginRuntimePermission(
  pluginId: unknown,
  permission: unknown,
  storage?: PluginRuntimePermissionGrantStorage | null,
) {
  const normalizedPluginId = normalizePluginRuntimePluginId(pluginId);
  const normalizedPermission = normalizePluginRuntimePermission(permission);
  if (!normalizedPluginId || !normalizedPermission) return false;
  const grants = loadPluginRuntimePermissionGrants(storage);
  const permissions = normalizePluginRuntimePermissionList(grants[normalizedPluginId]);
  if (permissions.includes(normalizedPermission)) return false;
  const nextGrants = {
    ...grants,
    [normalizedPluginId]: [...permissions, normalizedPermission],
  };
  if (!savePluginRuntimePermissionGrants(nextGrants, storage)) return false;
  dispatchPluginRuntimePermissionGrantsUpdated(normalizedPluginId, nextGrants);
  return true;
}

export function clearPluginRuntimePermissionGrants(
  pluginId: unknown,
  storage?: PluginRuntimePermissionGrantStorage | null,
) {
  const normalizedPluginId = normalizePluginRuntimePluginId(pluginId);
  if (!normalizedPluginId) return false;
  const grants = loadPluginRuntimePermissionGrants(storage);
  if (!Object.prototype.hasOwnProperty.call(grants, normalizedPluginId)) return false;
  const nextGrants = { ...grants };
  delete nextGrants[normalizedPluginId];
  if (!savePluginRuntimePermissionGrants(nextGrants, storage)) return false;
  dispatchPluginRuntimePermissionGrantsUpdated(normalizedPluginId, nextGrants);
  return true;
}
