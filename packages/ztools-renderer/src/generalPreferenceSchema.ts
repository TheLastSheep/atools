import { utf8ByteLength } from "./utf8";
import { isBuiltinAppShortcuts, type RendererBuiltinAppShortcuts } from "./builtinAppShortcuts";

export { utf8ByteLength };

export interface RendererGeneralPreferenceValues {
  autoCheckUpdate: boolean;
  placeholder: string;
  theme: "system" | "light" | "dark";
  primaryColor: "blue" | "purple" | "green" | "orange" | "red" | "pink" | "custom";
  customColor: string;
  autoClear: "immediately" | "1m" | "2m" | "3m" | "5m" | "10m" | "never";
  showRecentInSearch: boolean;
  recentRows: number;
  pinnedRows: number;
  searchMode: "aggregate" | "list";
  showMatchRecommendation: boolean;
  tabKeyFunction: "navigate" | "target-command";
  tabTargetCommand: string;
  spaceOpenCommand: boolean;
  localAppSearch: boolean;
  autoPaste: "off" | "1s" | "3s" | "5s" | "10s";
  builtinAppShortcutsEnabled: RendererBuiltinAppShortcuts;
}

export type RendererGeneralPreferenceField = keyof RendererGeneralPreferenceValues;

export const MAX_GENERAL_PREFERENCE_RAW_BYTES = 64 * 1024;
export const MAX_GENERAL_PREFERENCE_PLACEHOLDER_WRITE_BYTES = 512;

export const GENERAL_RENDERER_EVENT_FIELDS: readonly RendererGeneralPreferenceField[] = [
  "placeholder", "theme", "primaryColor", "customColor", "autoClear",
  "showRecentInSearch", "recentRows", "pinnedRows", "searchMode",
  "showMatchRecommendation", "tabKeyFunction", "tabTargetCommand", "spaceOpenCommand",
  "localAppSearch", "autoPaste", "builtinAppShortcutsEnabled", "autoCheckUpdate",
];
export const GENERAL_RENDERER_WRITE_FIELDS: ReadonlySet<string> = new Set(GENERAL_RENDERER_EVENT_FIELDS.slice(0, 5));

const enums: Readonly<Record<string, ReadonlySet<string>>> = {
  theme: new Set(["system", "light", "dark"]),
  primaryColor: new Set(["blue", "purple", "green", "orange", "red", "pink", "custom"]),
  autoPaste: new Set(["off", "1s", "3s", "5s", "10s"]),
  autoClear: new Set(["immediately", "1m", "2m", "3m", "5m", "10m", "never"]),
  searchMode: new Set(["aggregate", "list"]),
  tabKeyFunction: new Set(["navigate", "target-command"]),
};
const booleanFields: ReadonlySet<string> = new Set([
  "showRecentInSearch", "showMatchRecommendation", "spaceOpenCommand", "localAppSearch", "autoCheckUpdate",
]);
const controls = /[\u0000-\u001f\u007f-\u009f]/;
export function isGeneralPreferenceValue(
  field: string,
  value: unknown,
  placeholderWriteLimit?: number,
): boolean {
  if (field === "builtinAppShortcutsEnabled") return isBuiltinAppShortcuts(value);
  if (typeof value === "boolean") return booleanFields.has(field);
  if (typeof value === "number") return (field === "recentRows" || field === "pinnedRows") && Number.isInteger(value) && value >= 0 && value <= 20;
  if (typeof value !== "string") return false;
  if (field === "placeholder") {
    return !controls.test(value) && (placeholderWriteLimit === undefined || utf8ByteLength(value) <= placeholderWriteLimit);
  }
  if (field === "tabTargetCommand") return !controls.test(value);
  if (field === "customColor") return /^#[0-9a-fA-F]{6}$/.test(value);
  return Object.hasOwn(enums, field) && enums[field].has(value);
}
