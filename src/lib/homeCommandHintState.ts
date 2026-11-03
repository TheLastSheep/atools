import type { RecommendedCommand } from "./uiState";

export type HomeCommandHintIdentity = Pick<
  RecommendedCommand,
  "code" | "plugin_id" | "source" | "panel" | "label" | "input"
>;

/** Keep immutable string references; never serialize or normalize command payloads for hint identity. */
export function snapshotHomeCommandHintIdentity(command: RecommendedCommand): HomeCommandHintIdentity {
  return {
    code: command.code,
    plugin_id: command.plugin_id,
    source: command.source,
    panel: command.panel,
    label: command.label,
    input: command.input,
  };
}

export function matchesHomeCommandHintIdentity(
  identity: HomeCommandHintIdentity,
  command: RecommendedCommand,
): boolean {
  return identity.code === command.code
    && identity.plugin_id === command.plugin_id
    && identity.source === command.source
    && identity.panel === command.panel
    && identity.label === command.label
    && identity.input === command.input;
}
