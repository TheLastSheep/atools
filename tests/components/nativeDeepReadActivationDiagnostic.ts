export type DeepReadActivationStage = "port-unavailable" | "callback-reported-error";
export type DeepReadActivationErrorKind = "error" | "string" | "plain-object" | "malformed";
export type DeepReadActivationErrorName = "Error" | "TypeError" | "RangeError" | "TauriError" | "InvokeError" | "Other";
export type DeepReadActivationErrorCode =
  | "FILES_PORT_MISSING"
  | "COMMAND_NOT_FOUND"
  | "INVALID_ARGUMENTS"
  | "TASK_RUN_CREATE_FAILED"
  | "FILE_INPUT_EMPTY"
  | "FILE_INPUT_BUDGET"
  | "FILE_INPUT_INVALID"
  | "FILE_INPUT_UNAVAILABLE"
  | "FILE_INPUT_UNSUPPORTED"
  | "FEATURE_OWNER_CHANGED"
  | "APP_ACTIVATION_PORT_UNAVAILABLE"
  | "ACTIVATION_SCOPE_UNAVAILABLE"
  | "ACTIVATION_INPUT_OUT_OF_SCOPE"
  | "ACTIVATION_SCOPE_ENDED"
  | "ACTIVATION_REJECTED";

const REASONS: Record<DeepReadActivationErrorCode, string> = {
  FILES_PORT_MISSING: "The fixture has no files-activation port.",
  COMMAND_NOT_FOUND: "Reported error category: command not found.",
  INVALID_ARGUMENTS: "Reported error category: invalid arguments.",
  TASK_RUN_CREATE_FAILED: "Reported error category: TaskRun creation or persistence.",
  FILE_INPUT_EMPTY: "Reported error category: file input empty.",
  FILE_INPUT_BUDGET: "Reported error category: file input exceeds bounds.",
  FILE_INPUT_INVALID: "Reported error category: file input invalid.",
  FILE_INPUT_UNAVAILABLE: "Reported error category: file input unavailable.",
  FILE_INPUT_UNSUPPORTED: "Reported error category: file input unsupported.",
  FEATURE_OWNER_CHANGED: "Reported error category: feature owner changed.",
  APP_ACTIVATION_PORT_UNAVAILABLE: "Reported error category: App activation port unavailable.",
  ACTIVATION_SCOPE_UNAVAILABLE: "Reported error category: activation scope unavailable.",
  ACTIVATION_INPUT_OUT_OF_SCOPE: "Reported error category: activation input outside fixed scope.",
  ACTIVATION_SCOPE_ENDED: "Reported error category: activation scope ended during activation.",
  ACTIVATION_REJECTED: "Reported error category: activation rejected; raw details omitted."
};
const FILE_INPUT_CODES = new Set<DeepReadActivationErrorCode>([
  "FILE_INPUT_EMPTY", "FILE_INPUT_BUDGET", "FILE_INPUT_INVALID", "FILE_INPUT_UNAVAILABLE", "FILE_INPUT_UNSUPPORTED"
]);
const SAFE_ERROR_NAMES = new Set<DeepReadActivationErrorName>(["Error", "TypeError", "RangeError", "TauriError", "InvokeError"]);
const MAX_REASON_CHARS = 160;
const MAX_INPUT_TEXT_CHARS = 1024;
const MAX_SERIALIZED_BYTES = 1024;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function errorName(value: unknown): DeepReadActivationErrorName {
  if (typeof value !== "string") return "Other";
  return SAFE_ERROR_NAMES.has(value as DeepReadActivationErrorName)
    ? value as DeepReadActivationErrorName : "Other";
}

function fixedCode(value: unknown): DeepReadActivationErrorCode | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const normalized = value.toUpperCase();
  if (normalized === "COMMAND_NOT_FOUND" || normalized === "TAURI_COMMAND_NOT_FOUND") return "COMMAND_NOT_FOUND";
  if (["INVALID_ARGUMENTS", "INVALID_ARGS", "INVALID_ARGUMENT"].includes(normalized)) return "INVALID_ARGUMENTS";
  if (["TASK_RUN_CREATE_FAILED", "TASK_RUN_PERSIST_FAILED", "DATABASE_TASK_RUN_FAILED"].includes(normalized)) return "TASK_RUN_CREATE_FAILED";
  if (["FEATURE_OWNER_CHANGED"].includes(normalized)) return "FEATURE_OWNER_CHANGED";
  if (FILE_INPUT_CODES.has(normalized as DeepReadActivationErrorCode)) return normalized as DeepReadActivationErrorCode;
  return null;
}

const EXACT_ACTIVATION_MESSAGES: ReadonlyMap<string, DeepReadActivationErrorCode> = new Map([
  ["App desktop-smoke activation port is unavailable", "APP_ACTIVATION_PORT_UNAVAILABLE"],
  ["Desktop smoke activation scope is unavailable", "ACTIVATION_SCOPE_UNAVAILABLE"],
  ["DeepRead smoke activation input is outside its fixed fixture scope", "ACTIVATION_INPUT_OUT_OF_SCOPE"],
  ["Desktop smoke activation scope ended during feature activation", "ACTIVATION_SCOPE_ENDED"]
]);

function classifyError(code: unknown, message: string): DeepReadActivationErrorCode {
  const exact = fixedCode(code);
  if (exact) return exact;
  const exactActivation = EXACT_ACTIVATION_MESSAGES.get(message);
  if (exactActivation) return exactActivation;
  const sample = message.slice(0, MAX_INPUT_TEXT_CHARS).toLowerCase();
  if (/\b(?:command|invoke)\b.{0,96}\b(?:not found|not registered|unknown command|unrecognized command)\b/.test(sample)
    || /\b(?:not found|not registered|unknown command)\b.{0,96}\b(?:command|invoke)\b/.test(sample)) return "COMMAND_NOT_FOUND";
  if (/\b(?:invalid (?:args?|arguments?)|missing required (?:argument|parameter)|unexpected (?:argument|parameter)|expected .{1,96} (?:argument|parameter))\b/.test(sample)) {
    return "INVALID_ARGUMENTS";
  }
  if (/\btask[\s_-]?run\b.{0,96}\b(?:create|persist|insert|write)\b|\b(?:create|persist|insert|write)\b.{0,96}\btask[\s_-]?run\b/.test(sample)) {
    return "TASK_RUN_CREATE_FAILED";
  }
  if (/\bfile_input_empty\b/.test(sample)) return "FILE_INPUT_EMPTY";
  if (/\bfile_input_budget\b/.test(sample)) return "FILE_INPUT_BUDGET";
  if (/\bfile_input_invalid\b/.test(sample)) return "FILE_INPUT_INVALID";
  if (/\bfile_input_unavailable\b/.test(sample)) return "FILE_INPUT_UNAVAILABLE";
  if (/\bfile_input_unsupported\b/.test(sample)) return "FILE_INPUT_UNSUPPORTED";
  if (/\bfeature_owner_changed\b/.test(sample)) return "FEATURE_OWNER_CHANGED";
  return "ACTIVATION_REJECTED";
}

/** Returns only fixed metadata and normalized reasons; no input text, stack, or payload is copied. */
export function projectDeepReadActivationFailure(error: unknown, stage: DeepReadActivationStage) {
  let kind: DeepReadActivationErrorKind = "malformed";
  let name: DeepReadActivationErrorName = "Other";
  let code: unknown;
  let message = "";
  try {
    if (error instanceof Error) {
      kind = "error";
      name = errorName(error.name);
      message = typeof error.message === "string" ? error.message.slice(0, MAX_INPUT_TEXT_CHARS) : "";
      code = (error as Error & { code?: unknown }).code;
    } else if (typeof error === "string") {
      kind = "string";
      message = error.slice(0, MAX_INPUT_TEXT_CHARS);
    } else if (plainRecord(error)) {
      kind = "plain-object";
      name = errorName(error.name);
      message = typeof error.message === "string" ? error.message.slice(0, MAX_INPUT_TEXT_CHARS) : "";
      code = error.code;
    }
  } catch {
    kind = "malformed";
    name = "Other";
    code = undefined;
    message = "";
  }
  const errorCode = stage === "port-unavailable" ? "FILES_PORT_MISSING" : classifyError(code, message);
  const result = {
    phase: "deepread-original-fixed-file-import" as const,
    command: "activate_file_content_feature" as const,
    featureCode: "deepread-import" as const,
    pluginId: "deepread" as const,
    fileCount: 1 as const,
    activationStage: stage,
    errorKind: kind,
    errorName: name,
    errorCode,
    reason: REASONS[errorCode].slice(0, MAX_REASON_CHARS)
  };
  // This fixed projection is deliberately small enough for bounded fixture reports.
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_SERIALIZED_BYTES) {
    return { ...result, reason: "Activation failed; raw details were omitted." };
  }
  return result;
}
