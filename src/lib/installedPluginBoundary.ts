import type { InstalledPlugin } from "./types";
import { validatedPluginInventoryLogoPath } from "./pluginInventoryLogo";

/** Validate and normalize IPC values before they enter settings state or drive an operation. */
export function normalizeInstalledPlugin(value: unknown): InstalledPlugin | null {
  if (!record(value)) return null;
  if (!nonEmptyString(value.id) || !string(value.name) || !string(value.version) || !nonEmptyString(value.path)
    || typeof value.enabled !== "boolean" || !string(value.created_at) || !string(value.updated_at)
    || !validManifest(value.manifest)) return null;
  if ("source_kind" in value && value.source_kind !== "builtin" && value.source_kind !== "imported" && value.source_kind !== "external") return null;
  const rawManifest = value.manifest as Record<string, unknown>;
  const manifest = rawManifest.features === undefined
    ? rawManifest
    : {
      ...rawManifest,
      features: (rawManifest.features as Array<Record<string, unknown>>).map((feature) => ({
        ...feature,
        explain: typeof feature.explain === "string" ? feature.explain : "",
      })),
    } as InstalledPlugin["manifest"];
  return {
    ...value,
    ...(Object.prototype.hasOwnProperty.call(value, "inventory_logo_path")
      ? { inventory_logo_path: validatedPluginInventoryLogoPath(value.inventory_logo_path, value.source_kind) }
      : {}),
    manifest,
  } as InstalledPlugin;
}

export function parseInstalledPluginList(value: unknown): InstalledPlugin[] {
  if (!Array.isArray(value)) throw new Error("插件清单格式无效：预期为数组");
  const ids = new Set<string>();
  const plugins: InstalledPlugin[] = [];
  for (const item of value) {
    const plugin = normalizeInstalledPlugin(item);
    if (!plugin) throw new Error("插件清单格式无效：记录缺少必需字段或 manifest.features 结构异常");
    if (ids.has(plugin.id)) throw new Error(`插件清单格式无效：重复插件 ID ${plugin.id}`);
    ids.add(plugin.id);
    plugins.push(plugin);
  }
  return plugins;
}

export function sanitizeInitialPluginList(value: unknown): { plugins: InstalledPlugin[]; invalidCount: number } {
  if (!Array.isArray(value)) return { plugins: [], invalidCount: 1 };
  const ids = new Set<string>();
  const plugins: InstalledPlugin[] = [];
  let invalidCount = 0;
  for (const item of value) {
    const plugin = normalizeInstalledPlugin(item);
    if (!plugin || ids.has(plugin.id)) {
      invalidCount += 1;
      continue;
    }
    ids.add(plugin.id);
    plugins.push(plugin);
  }
  return { plugins, invalidCount };
}

function validManifest(value: unknown): boolean {
  if (!record(value)) return false;
  if ("title" in value && value.title !== null && !string(value.title)) return false;
  if ("description" in value && value.description !== null && !string(value.description)) return false;
  if ("features" in value && !Array.isArray(value.features)) return false;
  return !Array.isArray(value.features) || value.features.every((feature) => {
    if (!record(feature) || !string(feature.code)) return false;
    if ("explain" in feature && !string(feature.explain)) return false;
    return !("label" in feature) || feature.label === null || string(feature.label);
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): value is string { return typeof value === "string"; }
function nonEmptyString(value: unknown): value is string { return string(value) && Boolean(value.trim()); }
