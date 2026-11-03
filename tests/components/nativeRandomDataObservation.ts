const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep volatile preview and input text out of persistent native fixture observations. */
export function projectRandomDataState(value: unknown, acceptanceCommand: string) {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const commands = Array.isArray(state.commands) ? state.commands.slice(0, 32) : [];
  const preview = typeof state.preview === "string" ? state.preview : "";
  return {
    ready: state.ready === true,
    enabled: state.enabled === true,
    uuidCommandEnabled: commands.includes("uuid"),
    acceptanceCommandPresent: commands.includes(acceptanceCommand),
    commandCount: commands.length,
    inputMatchesAcceptance: state.input === acceptanceCommand,
    previewIsCanonicalUuid: preview.length <= 128 && UUID_SHAPE.test(preview),
    saveCompleted: state.saveStatus === "已自动保存",
  };
}
