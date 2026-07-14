/** Mirrors Rust `SearchResult` struct in src-tauri/src/commands.rs */
export type SearchResult = {
  code: string;
  plugin_id: string;
  plugin_name: string;
  label: string;
  icon: string | null;
  explain: string;
  score: number;
  match_type: string;
};

/** Mirrors Rust `FeatureAction` struct in src-tauri/src/commands.rs */
export type FeatureAction = {
  plugin_id: string;
  plugin_name: string;
  feature_code: string;
  main_url: string;
  plugin_path: string;
  preload_path?: string;
  expand_height: number;
  plugin_permissions?: string[];
  payload: unknown;
};

/** A single output item from a plugin, displayed in the result list */
export type PluginItem = {
  title: string;
  description?: string;
  data?: string;
  icon?: string;
};

/** Output payload from outPlugin() */
export type PluginOutput = {
  items: PluginItem[];
  plugin_id: string;
  feature_code: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: unknown;
  output_schema?: unknown;
  scopes: string[];
  enabled_by_default: boolean;
  enabled: boolean;
  source: string;
  plugin_id?: string | null;
};

export type McpServerStatus = {
  enabled: boolean;
  bind: string;
  token: string;
};

export type RuntimeEvent = {
  timestamp: string;
  level: string;
  message: string;
};

export type RuntimeDiagnostics = {
  runtime: string;
  platform: string;
  arch: string;
  debug: boolean;
  base_dir: string;
  db_path: string;
  plugins_dir: string;
  plugin_count: number;
  feature_count: number;
  agent_tool_count: number;
  enabled_agent_tool_count: number;
  mcp_enabled: boolean;
  mcp_bind?: string | null;
  active_plugin?: string | null;
  recent_events: RuntimeEvent[];
};

export type PluginMarketCatalogPlugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string | null;
  download_url: string;
  checksum?: string | null;
  rating?: string | null;
  rating_count?: number | null;
  downloads?: number | null;
  updated_at?: string | null;
  publisher?: string | null;
  publisher_url?: string | null;
  signature?: string | null;
  public_key?: string | null;
  homepage?: string | null;
};

export type PluginMarketCatalog = {
  source_url: string;
  updated_at?: string | null;
  plugins: PluginMarketCatalogPlugin[];
};

export type CrashLogEntry = {
  timestamp: string;
  message: string;
  location?: string | null;
  raw: string;
};

export type AuditLogEntry = {
  id: string;
  timestamp: string;
  client_id: string;
  tool_name: string;
  input: unknown;
  output: unknown;
  status: string;
  duration_ms: number;
  error?: string | null;
};

export type AuditLogQuery = {
  limit: number;
  offset?: number;
  query?: string | null;
  status?: string | null;
  tool_name?: string | null;
  client_id?: string | null;
};

export type AuditLogPage = {
  entries: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
};

export type AuditArchiveResult = {
  path: string;
  count: number;
};

export type ClipboardHistoryEntry = {
  id: string;
  text: string;
  first_copied_at: string;
  last_copied_at: string;
  used_count: number;
};

export type AgentToolGrant = {
  client_id: string;
  tool_name: string;
  created_at: string;
  updated_at: string;
};

export type AgentScopePolicy = {
  scope: string;
  label: string;
  description: string;
  decision: string;
  high_risk: boolean;
};

export type PendingAgentToolRequest = {
  id: string;
  run_id?: string | null;
  client_id: string;
  tool_name: string;
  arguments: unknown;
  scopes: string[];
  created_at: string;
};

export type TaskRunStatus = "created" | "awaiting_permission" | "running" | "partial" |
  "succeeded" | "failed" | "cancelled";

export type TaskRunArtifact = {
  id: string;
  kind: string;
  label: string;
  mediaType?: string | null;
  uri?: string | null;
  path?: string | null;
  sizeBytes?: number | null;
  metadata: unknown;
};

export type TaskRunIssue = {
  code: string;
  message: string;
  details: unknown;
  retryable: boolean;
};

export type TaskRun = {
  id: string;
  capabilityId: string;
  initiator: {
    type: "human" | "agent" | "automation";
    clientId?: string | null;
  };
  status: TaskRunStatus;
  input: unknown;
  output: unknown;
  summary?: string | null;
  progress?: number | null;
  artifacts: TaskRunArtifact[];
  warnings: TaskRunIssue[];
  errors: TaskRunIssue[];
  actions: Array<{
    id: string;
    label: string;
    capabilityId: string;
    input: unknown;
    requiresConfirmation: boolean;
  }>;
  memoryIds: string[];
  metrics: unknown;
  validation: {
    status: "not_run" | "passed" | "failed";
    summary?: string | null;
  };
  auditId?: string | null;
  retryOf?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

export type InstalledPlugin = {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  manifest: {
    description?: string | null;
    features?: Array<{
      code: string;
      label?: string | null;
      explain: string;
    }>;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
};

export type ZToolsImportCandidate = {
  path: string;
  name: string;
  title: string | null;
  version: string;
  features_count: number;
  platform_supported: boolean;
  main_exists: boolean;
  preload_exists: boolean;
  logo_exists: boolean;
  unsupported_cmd_types: string[];
  warnings: string[];
  errors: string[];
};

export type ZToolsImportFailure = {
  path: string;
  error: string;
};

export type ZToolsImportReport = {
  imported: string[];
  skipped: ZToolsImportCandidate[];
  failed: ZToolsImportFailure[];
};

export type WebdavUploadedFile = {
  name: string;
  url: string;
  bytes: number;
  status: number;
};

export type WebdavSyncSummary = {
  status: string;
  remote_path: string;
  files_uploaded: WebdavUploadedFile[];
  uploaded_bytes: number;
  remote_manifest_verified: boolean;
  remote_manifest_bytes: number;
  duration_ms: number;
};

export type WebdavPreviewFile = {
  name: string;
  url: string;
  declared_bytes?: number | null;
  downloaded_bytes: number;
  summary: string;
};

export type WebdavBackupPreview = {
  status: string;
  remote_path: string;
  manifest_kind?: string | null;
  exported_at?: string | null;
  files: WebdavPreviewFile[];
  duration_ms: number;
};

export type WebdavPluginDataConflictDocument = {
  plugin_id: string;
  plugin_name: string;
  doc_id: string;
  local_summary: string;
  remote_summary: string;
};

export type WebdavRestorePlanItem = {
  scope: string;
  file_name: string;
  action: string;
  local_summary: string;
  remote_summary: string;
  changed_keys: string[];
  skipped_keys: string[];
  plugin_conflicts?: WebdavPluginDataConflictDocument[];
  high_risk: boolean;
};

export type WebdavRestorePlan = {
  status: string;
  remote_path: string;
  manifest_kind?: string | null;
  exported_at?: string | null;
  items: WebdavRestorePlanItem[];
  duration_ms: number;
};

export type WebdavSettingsRestoreResult = {
  status: string;
  remote_path: string;
  manifest_kind?: string | null;
  exported_at?: string | null;
  applied_keys: string[];
  skipped_keys: string[];
  merged_settings: unknown;
  duration_ms: number;
};

export type WebdavClipboardRestoreResult = {
  status: string;
  remote_path: string;
  manifest_kind?: string | null;
  exported_at?: string | null;
  remote_entries: number;
  imported_entries: number;
  skipped_entries: number;
  duration_ms: number;
};

export type WebdavPluginDataRestoreResult = {
  status: string;
  remote_path: string;
  manifest_kind?: string | null;
  exported_at?: string | null;
  remote_plugins: number;
  remote_documents: number;
  imported_documents: number;
  overwritten_documents: number;
  skipped_documents: number;
  conflict_documents: number;
  unchanged_documents: number;
  missing_plugins: number;
  duration_ms: number;
};

export type AiConnectionTestResult = {
  status: string;
  provider: string;
  base_url: string;
  model: string;
  models_count: number;
  model_found: boolean;
  duration_ms: number;
};

/** Map match_type strings to human-readable labels + tone classes */
export const MATCH_TYPE_META: Record<string, { label: string; tone: string }> = {
  exact:     { label: "精确", tone: "exact" },
  prefix:    { label: "前缀", tone: "prefix" },
  contains:  { label: "包含", tone: "contains" },
  regex:     { label: "正则", tone: "regex" },
  alias:     { label: "别名", tone: "alias" },
  over:      { label: "长度", tone: "over" },
  pinyin:    { label: "拼音", tone: "pinyin" },
  fuzzy:     { label: "模糊", tone: "fuzzy" },
  pending:   { label: "待处理", tone: "pending" },
};
