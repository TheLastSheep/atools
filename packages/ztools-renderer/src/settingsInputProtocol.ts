import { utf8ByteLength } from "./utf8";

export const RENDERER_SETTINGS_INPUT_CALLBACKS = [
  "onUpdateSubInputVisible",
  "onUpdateSubInputPlaceholder",
  "onSetSubInputValue",
  "onFocusSubInput",
  "onSelectSubInput",
] as const;

export type RendererSettingsInputCallbackName = typeof RENDERER_SETTINGS_INPUT_CALLBACKS[number];
export type RendererSettingsInputAction = "set" | "remove" | "value" | "focus" | "blur" | "select";

export type RendererSettingsInputEvent = {
  version: 1;
  kind: "subInput";
  sessionId: string;
  bundleRevision: string;
  generation: number;
  revision: number;
  valueVersion: number;
  action: RendererSettingsInputAction;
  visible: boolean;
  placeholder: string;
  value: string;
  focus: boolean;
};

const INPUT_KEYS = [
  "version", "kind", "sessionId", "bundleRevision", "generation", "revision", "valueVersion",
  "action", "visible", "placeholder", "value", "focus",
] as const;
const SESSION_ID = /^[0-9a-f]{32}$/;
const BUNDLE_REVISION = /^[0-9a-f]{64}$/;
const ACTIONS = new Set<RendererSettingsInputAction>(["set", "remove", "value", "focus", "blur", "select"]);
export function parseRendererSettingsInputEvent(record: Record<string, unknown>): RendererSettingsInputEvent {
  if (
    Object.keys(record).length !== INPUT_KEYS.length || !INPUT_KEYS.every((key) => Object.hasOwn(record, key)) ||
    record.version !== 1 || record.kind !== "subInput" || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId) ||
    typeof record.bundleRevision !== "string" || !BUNDLE_REVISION.test(record.bundleRevision) ||
    !positiveSafeInteger(record.generation) || !positiveSafeInteger(record.revision) ||
    !Number.isSafeInteger(record.valueVersion) || (record.valueVersion as number) < 0 ||
    typeof record.action !== "string" || !ACTIONS.has(record.action as RendererSettingsInputAction) ||
    typeof record.visible !== "boolean" || typeof record.placeholder !== "string" || utf8ByteLength(record.placeholder) > 512 ||
    typeof record.value !== "string" || utf8ByteLength(record.value) > 16 * 1024 || typeof record.focus !== "boolean"
  ) throw new Error("Invalid renderer settings input event.");
  return record as unknown as RendererSettingsInputEvent;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
