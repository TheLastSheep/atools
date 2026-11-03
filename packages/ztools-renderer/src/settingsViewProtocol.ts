import { safeEventRecord } from "./safeEventRecord";
import { utf8ByteLength } from "./utf8";

export const RENDERER_SETTINGS_VIEW_EVENT = "atools://renderer-settings-view" as const;
export const RENDERER_SETTINGS_VIEW_PHASES = ["placeholder", "opened", "loaded", "closed", "back-to-search"] as const;
const MAX_LOGO_BYTES = 256 * 1024;
const SESSION_ID = /^[0-9a-f]{32}$/;
const LOGO_URI = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/i;

export type RendererSettingsViewPhase = typeof RENDERER_SETTINGS_VIEW_PHASES[number];
export type RendererSettingsViewPlugin = {
  name: "setting";
  title: "设置";
  logo: string;
  path: "atools:internal/setting";
  cmdName: "设置";
  subInputPlaceholder: "搜索";
  subInputVisible: false;
};

export interface RendererSettingsViewEvent {
  version: 1;
  sessionId: string;
  phase: RendererSettingsViewPhase;
  plugin?: RendererSettingsViewPlugin;
}

export type RendererSettingsViewOpenReceipt = { version: 1; sessionId: string };
type RendererAutomaticReturnEvent = { version: 1; phase: "auto-back-to-search" };

export function parseRendererSettingsViewOpenReceipt(value: unknown): RendererSettingsViewOpenReceipt {
  const record = safeEventRecord(value);
  if (Object.keys(record).length !== 2 || record.version !== 1 || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)) throw invalidResponse();
  return { version: 1, sessionId: record.sessionId };
}

export function parseRendererSettingsViewEvent(value: unknown): RendererSettingsViewEvent | RendererAutomaticReturnEvent {
  const record = safeEventRecord(value);
  if (record.version !== 1) throw invalidResponse();
  if (record.phase === "auto-back-to-search") {
    if (Object.keys(record).length !== 2) throw invalidResponse();
    return { version: 1, phase: "auto-back-to-search" };
  }
  if (typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId) || typeof record.phase !== "string" || !RENDERER_SETTINGS_VIEW_PHASES.includes(record.phase as RendererSettingsViewPhase)) throw invalidResponse();
  const phase = record.phase as RendererSettingsViewPhase;
  const hasPlugin = Object.hasOwn(record, "plugin");
  if ((phase === "opened") !== hasPlugin || Object.keys(record).length !== (hasPlugin ? 4 : 3)) throw invalidResponse();
  const plugin = hasPlugin ? parsePlugin(record.plugin) : undefined;
  return { version: 1, sessionId: record.sessionId, phase, ...(plugin ? { plugin } : {}) };
}

function parsePlugin(value: unknown): RendererSettingsViewPlugin {
  const record = safeEventRecord(value);
  if (Object.keys(record).length !== 7) throw invalidResponse();
  if (record.name !== "setting" || record.title !== "设置" || typeof record.logo !== "string" || utf8ByteLength(record.logo) > MAX_LOGO_BYTES || !LOGO_URI.test(record.logo) || record.path !== "atools:internal/setting" || record.cmdName !== "设置" || record.subInputPlaceholder !== "搜索" || record.subInputVisible !== false) throw invalidResponse();
  return { name: "setting", title: "设置", logo: record.logo, path: "atools:internal/setting", cmdName: "设置", subInputPlaceholder: "搜索", subInputVisible: false };
}

function invalidResponse(): Error {
  return new Error("Invalid renderer settings view response.");
}
