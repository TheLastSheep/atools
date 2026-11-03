/** Semantic feedback intent is assigned where the operation happens, independently of copy. */
export type PluginInventoryMessageKind =
  | "none" | "progress" | "read-success" | "action-success" | "cancelled"
  | "warning" | "read-failure" | "readback-recovery" | "action-failure";

export type PluginInventoryFeedback = {
  kind: PluginInventoryMessageKind | "open-failure";
  tone: "neutral" | "busy" | "success" | "warning" | "error";
  visibility: "visible" | "announcement";
  messages: string[];
  retryList: boolean;
};

type FeedbackSource = {
  message: string;
  messageKind: PluginInventoryMessageKind;
  error: string;
  refreshError: string;
};

export function pluginInventoryFeedback(source: FeedbackSource, openingMessage = ""): PluginInventoryFeedback | null {
  const messages = [source.message, source.error, source.refreshError, openingMessage].filter(Boolean);
  if (!messages.length) return null;
  const kind = openingMessage ? "open-failure"
    : source.refreshError ? source.messageKind === "readback-recovery" ? "readback-recovery" : "read-failure"
    : source.error ? "action-failure" : source.messageKind;
  const tone = kind === "warning" || kind === "readback-recovery" ? "warning"
    : kind === "read-failure" || kind === "action-failure" || kind === "open-failure" ? "error"
    : kind === "progress" ? "busy" : kind === "action-success" ? "success" : "neutral";
  return {
    kind, tone, messages, retryList: Boolean(source.refreshError),
    visibility: kind === "read-success" ? "announcement" : "visible",
  };
}
