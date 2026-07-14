# ATools Agent Permission MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the next macOS-first Agent safety loop: persisted tool registry, per-client tool authorization, UI-visible confirmation requests, audit detail/export, and stable MCP retry behavior.

**Architecture:** Rust core owns durable data models and SQLite persistence. Tauri desktop owns runtime execution, pending confirmation requests, MCP HTTP/stdio integration, and audit writes. Svelte UI owns human-facing tool management, confirmation review, permission revocation, and audit inspection.

**Tech Stack:** Tauri 2, Rust, SQLite via rusqlite, Svelte 5/TypeScript, MCP JSON-RPC over local HTTP plus stdio proxy.

---

## Scope

This plan covers the next deliverable only: the Agent/MCP safety and management loop. It does not upgrade OCR engines, image encoders, Finder/browser context capture, Windows support, or dynamic plugin tool execution. Those remain separate follow-up plans after this loop is verified.

The repository at `/Users/harris/Desktop/atools` is currently not a git repository, so commit steps are replaced by concrete verification commands.

## File Structure

- Modify `crates/atools-core/src/agent.rs`
  - Add persistent tool metadata fields and permission grant models.
  - Keep existing `ToolDefinition` API compatible by adding optional/default fields only.
- Modify `crates/atools-core/src/db.rs`
  - Add `agent_tools` and `agent_tool_grants` tables.
  - Add CRUD methods for tool sync, tool enablement, grants, and audit export.
- Modify `crates/atools-core/tests/agent_tests.rs`
  - Add tests for tool persistence, plugin tool default-disabled behavior, and grant round-trips.
- Modify `src-tauri/src/agent_tools.rs`
  - Sync built-in tools to the database.
  - Evaluate per-client grants before asking for confirmation.
  - Return a stable confirmation request payload when a tool requires human approval.
- Modify `src-tauri/src/state.rs`
  - Store pending Agent confirmation requests in memory.
- Modify `src-tauri/src/commands.rs`
  - Add commands for listing tools, toggling tools, listing grants, revoking grants, listing pending requests, and exporting audit JSONL.
- Modify `src-tauri/src/lib.rs`
  - Register new commands and sync the built-in tool registry during app setup.
- Modify `src-tauri/src/mcp_server.rs`
  - Ensure MCP `tools/list` reads enabled tools from the persisted registry.
  - Ensure MCP `tools/call` creates a pending confirmation request and returns `permission_required`.
- Modify `src/lib/types.ts`
  - Add TypeScript mirrors for grants, pending requests, and audit export status.
- Modify `src/components/AgentPanel.svelte`
  - Add tabs/sections for pending requests, tool toggles, grants, audit detail, and export.
- Create `docs/agent-mcp-client.md`
  - Document HTTP and stdio MCP client setup, retry flow, token location, and limitations.
- Modify or create `src-tauri/tests/agent_tools_tests.rs`
  - Add tests for per-client grant evaluation and confirmation request payloads.

---

### Task 1: Persist Agent Tool Registry And Grants

**Files:**
- Modify: `/Users/harris/Desktop/atools/crates/atools-core/src/agent.rs`
- Modify: `/Users/harris/Desktop/atools/crates/atools-core/src/db.rs`
- Modify: `/Users/harris/Desktop/atools/crates/atools-core/tests/agent_tests.rs`

- [x] **Step 1: Write failing core tests**

Add tests to `crates/atools-core/tests/agent_tests.rs`:

```rust
#[test]
fn agent_tools_round_trip_through_database_with_enabled_state() {
    let db = Database::in_memory().unwrap();
    let tool = ToolDefinition {
        name: "find_local_files".to_string(),
        description: "Find local files".to_string(),
        input_schema: json!({"type": "object"}),
        output_schema: Some(json!({"type": "object"})),
        scopes: vec![PermissionScope::FileRead],
        enabled_by_default: true,
        enabled: true,
        source: "builtin".to_string(),
        plugin_id: None,
    };

    db.sync_agent_tools(&[tool.clone()]).unwrap();
    let tools = db.list_agent_tools().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "find_local_files");
    assert!(tools[0].enabled);

    db.set_agent_tool_enabled("find_local_files", false).unwrap();
    let disabled = db.get_agent_tool("find_local_files").unwrap().unwrap();
    assert!(!disabled.enabled);
}

#[test]
fn agent_tool_grants_round_trip_by_client_and_tool() {
    let db = Database::in_memory().unwrap();

    assert!(!db.is_agent_tool_granted("mcp-http", "find_local_files").unwrap());
    db.grant_agent_tool("mcp-http", "find_local_files").unwrap();
    assert!(db.is_agent_tool_granted("mcp-http", "find_local_files").unwrap());

    let grants = db.list_agent_tool_grants().unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].client_id, "mcp-http");
    assert_eq!(grants[0].tool_name, "find_local_files");

    assert!(db.revoke_agent_tool("mcp-http", "find_local_files").unwrap());
    assert!(!db.is_agent_tool_granted("mcp-http", "find_local_files").unwrap());
}
```

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
cargo test -p atools-core --test agent_tests agent_tools_round_trip_through_database_with_enabled_state agent_tool_grants_round_trip_by_client_and_tool
```

Expected: FAIL because `ToolDefinition.enabled`, `ToolDefinition.plugin_id`, `AgentToolGrant`, and the database methods do not exist.

- [x] **Step 3: Add core models**

Update `ToolDefinition` in `crates/atools-core/src/agent.rs` by adding optional/default-compatible fields:

```rust
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
```

Add:

```rust
fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolGrant {
    pub client_id: String,
    pub tool_name: String,
    pub created_at: String,
    pub updated_at: String,
}
```

Update `ToolRegistry::list_enabled()` to require both `enabled_by_default` and `enabled`.

- [x] **Step 4: Add SQLite persistence**

Update `run_migrations()` in `crates/atools-core/src/db.rs` with tables:

```sql
CREATE TABLE IF NOT EXISTS agent_tools (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    input_schema TEXT NOT NULL,
    output_schema TEXT,
    scopes TEXT NOT NULL,
    enabled_by_default BOOLEAN NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    plugin_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_grants (
    client_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (client_id, tool_name)
);
```

Add methods:

```rust
pub fn sync_agent_tools(&self, tools: &[ToolDefinition]) -> Result<()>;
pub fn list_agent_tools(&self) -> Result<Vec<ToolDefinition>>;
pub fn get_agent_tool(&self, name: &str) -> Result<Option<ToolDefinition>>;
pub fn set_agent_tool_enabled(&self, name: &str, enabled: bool) -> Result<bool>;
pub fn grant_agent_tool(&self, client_id: &str, tool_name: &str) -> Result<()>;
pub fn revoke_agent_tool(&self, client_id: &str, tool_name: &str) -> Result<bool>;
pub fn is_agent_tool_granted(&self, client_id: &str, tool_name: &str) -> Result<bool>;
pub fn list_agent_tool_grants(&self) -> Result<Vec<AgentToolGrant>>;
```

- [x] **Step 5: Run tests to verify GREEN**

Run:

```bash
cargo test -p atools-core --test agent_tests
```

Expected: PASS.

---

### Task 2: Wire Persisted Registry Into Tauri And MCP

**Files:**
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/agent_tools.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/lib.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/commands.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/mcp_server.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/tests/agent_tools_tests.rs`

- [x] **Step 1: Write failing tests**

Add tests to `src-tauri/tests/agent_tools_tests.rs`:

```rust
#[test]
fn builtin_tools_sync_to_database_and_list_enabled_tools() {
    let db = atools_core::Database::in_memory().unwrap();

    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();
    let tools = atools_lib::agent_tools::list_enabled_tools(&db).unwrap();

    assert!(tools.iter().any(|tool| tool.name == "find_local_files"));
    assert!(tools.iter().all(|tool| tool.enabled));

    db.set_agent_tool_enabled("find_local_files", false).unwrap();
    let enabled = atools_lib::agent_tools::list_enabled_tools(&db).unwrap();
    assert!(!enabled.iter().any(|tool| tool.name == "find_local_files"));
}
```

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
cargo test -p atools --test agent_tools_tests builtin_tools_sync_to_database_and_list_enabled_tools
```

Expected: FAIL because `sync_builtin_tools` and `list_enabled_tools` do not exist.

- [x] **Step 3: Implement Tauri registry helpers**

Add to `src-tauri/src/agent_tools.rs`:

```rust
pub fn sync_builtin_tools(db: &Database) -> Result<(), String> {
    db.sync_agent_tools(&builtin_tool_registry().list_all())
        .map_err(|e| e.to_string())
}

pub fn list_enabled_tools(db: &Database) -> Result<Vec<ToolDefinition>, String> {
    let tools = db.list_agent_tools().map_err(|e| e.to_string())?;
    Ok(tools.into_iter().filter(|tool| tool.enabled).collect())
}
```

Add `ToolRegistry::list_all()` in `crates/atools-core/src/agent.rs`.

- [x] **Step 4: Wire commands and startup**

In `src-tauri/src/lib.rs`, call `agent_tools::sync_builtin_tools(&app_state.inner().db)` during setup before starting MCP.

In `src-tauri/src/commands.rs`, change `list_agent_tools()` to take state and return persisted tools. Add:

```rust
#[tauri::command]
pub fn set_agent_tool_enabled(state: tauri::State<AppState>, name: String, enabled: bool) -> Result<bool, String>;
```

Register this command in `tauri::generate_handler!`.

- [x] **Step 5: Change MCP tools/list**

In `src-tauri/src/mcp_server.rs`, build a registry from `agent_tools::list_enabled_tools(&db)` instead of calling `builtin_tool_registry()` directly.

- [x] **Step 6: Run tests**

Run:

```bash
cargo test -p atools --test agent_tools_tests
cargo test --workspace
```

Expected: PASS.

---

### Task 3: Add Per-Client Grant Evaluation

**Files:**
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/agent_tools.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/commands.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/tests/agent_tools_tests.rs`

- [x] **Step 1: Write failing tests**

Add tests:

```rust
#[test]
fn permission_policy_uses_persisted_client_tool_grants() {
    let db = atools_core::Database::in_memory().unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();

    let before = atools_lib::agent_tools::permission_decision_for_tool(
        &db,
        "mcp-http",
        "find_local_files",
    )
    .unwrap();
    assert_eq!(before, atools_core::agent::PermissionDecision::Confirm);

    db.grant_agent_tool("mcp-http", "find_local_files").unwrap();
    let after = atools_lib::agent_tools::permission_decision_for_tool(
        &db,
        "mcp-http",
        "find_local_files",
    )
    .unwrap();
    assert_eq!(after, atools_core::agent::PermissionDecision::Allow);
}
```

- [x] **Step 2: Run test to verify RED**

Run:

```bash
cargo test -p atools --test agent_tools_tests permission_policy_uses_persisted_client_tool_grants
```

Expected: FAIL because `permission_decision_for_tool` does not exist.

- [x] **Step 3: Implement grant-aware evaluation**

Add:

```rust
pub fn permission_decision_for_tool(
    db: &Database,
    client_id: &str,
    tool_name: &str,
) -> Result<PermissionDecision, String>;
```

Implementation loads the tool from `db.get_agent_tool(tool_name)`, denies unknown/disabled tools, allows if mode is `developer`, allows if `db.is_agent_tool_granted(client_id, tool_name)` is true, otherwise confirms.

- [x] **Step 4: Add commands**

Add commands:

```rust
#[tauri::command]
pub fn grant_agent_tool(state: tauri::State<AppState>, client_id: String, tool_name: String) -> Result<(), String>;

#[tauri::command]
pub fn revoke_agent_tool(state: tauri::State<AppState>, client_id: String, tool_name: String) -> Result<bool, String>;

#[tauri::command]
pub fn list_agent_tool_grants(state: tauri::State<AppState>) -> Result<Vec<AgentToolGrant>, String>;
```

Register them in `src-tauri/src/lib.rs`.

- [x] **Step 5: Run tests**

Run:

```bash
cargo test -p atools --test agent_tools_tests
cargo test --workspace
```

Expected: PASS.

---

### Task 4: Add Pending Confirmation Request Flow

**Files:**
- Modify: `/Users/harris/Desktop/atools/crates/atools-core/src/agent.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/state.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/agent_tools.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/commands.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/mcp_server.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/tests/agent_tools_tests.rs`

- [x] **Step 1: Write failing tests**

Add a pure test for request payload creation:

```rust
#[test]
fn confirmation_payload_contains_request_id_client_tool_and_scopes() {
    let db = atools_core::Database::in_memory().unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();

    let payload = atools_lib::agent_tools::build_permission_required_payload(
        &db,
        "mcp-http",
        "find_local_files",
    )
    .unwrap();

    assert_eq!(payload["permission_required"], true);
    assert!(payload["request_id"].as_str().unwrap().starts_with("agent-confirm-"));
    assert_eq!(payload["client_id"], "mcp-http");
    assert_eq!(payload["tool"], "find_local_files");
    assert!(payload["scopes"].as_array().unwrap().contains(&serde_json::json!("file_read")));
}
```

- [x] **Step 2: Run test to verify RED**

Run:

```bash
cargo test -p atools --test agent_tools_tests confirmation_payload_contains_request_id_client_tool_and_scopes
```

Expected: FAIL because the helper does not exist.

- [x] **Step 3: Add pending request model**

Add `PendingAgentToolRequest` to `crates/atools-core/src/agent.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAgentToolRequest {
    pub id: String,
    pub client_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub scopes: Vec<PermissionScope>,
    pub created_at: String,
}
```

Add `pending_agent_requests: Mutex<BTreeMap<String, PendingAgentToolRequest>>` to `AppState`.

- [x] **Step 4: Emit and list confirmation requests**

When `call_tool_with_audit()` needs confirmation and `confirmed` is false:

1. Build `PendingAgentToolRequest`.
2. Store it in state when called through Tauri/MCP paths that have `AppHandle`.
3. Emit event `agent-permission-request`.
4. Return MCP error payload with `permission_required`, `request_id`, `client_id`, `tool`, `scopes`, and `retry_after_grant: true`.

Add commands:

```rust
#[tauri::command]
pub fn list_pending_agent_requests(state: tauri::State<AppState>) -> Vec<PendingAgentToolRequest>;

#[tauri::command]
pub fn dismiss_pending_agent_request(state: tauri::State<AppState>, request_id: String) -> bool;
```

- [x] **Step 5: Run tests**

Run:

```bash
cargo test -p atools --test agent_tools_tests
cargo test --workspace
```

Expected: PASS.

---

### Task 5: Upgrade AgentPanel For Tools, Grants, Pending Requests, And Audit Details

**Files:**
- Modify: `/Users/harris/Desktop/atools/src/lib/types.ts`
- Modify: `/Users/harris/Desktop/atools/src/components/AgentPanel.svelte`

- [x] **Step 1: Add TypeScript models**

Add:

```ts
export type AgentToolGrant = {
  client_id: string;
  tool_name: string;
  created_at: string;
  updated_at: string;
};

export type PendingAgentToolRequest = {
  id: string;
  client_id: string;
  tool_name: string;
  arguments: unknown;
  scopes: string[];
  created_at: string;
};
```

- [x] **Step 2: Extend AgentPanel data loading**

Load:

```ts
invoke<AgentToolGrant[]>("list_agent_tool_grants")
invoke<PendingAgentToolRequest[]>("list_pending_agent_requests")
```

- [x] **Step 3: Add UI controls**

For each tool row:

```svelte
<input
  type="checkbox"
  checked={tool.enabled}
  onchange={(e) => toggleTool(tool.name, (e.target as HTMLInputElement).checked)}
/>
```

For each pending request:

```svelte
<button onclick={() => approveRequest(request)}>允许并记住</button>
<button onclick={() => dismissRequest(request.id)}>拒绝</button>
```

For each grant:

```svelte
<button onclick={() => revokeGrant(grant.client_id, grant.tool_name)}>撤销</button>
```

- [x] **Step 4: Run frontend checks**

Run:

```bash
pnpm check
```

Expected: `svelte-check found 0 errors and 0 warnings`.

---

### Task 6: Add Audit Detail And JSONL Export

**Files:**
- Modify: `/Users/harris/Desktop/atools/crates/atools-core/src/db.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/commands.rs`
- Modify: `/Users/harris/Desktop/atools/src/components/AgentPanel.svelte`

- [x] **Step 1: Write failing core test**

Add to `crates/atools-core/tests/agent_tests.rs`:

```rust
#[test]
fn audit_entries_export_as_jsonl() {
    let db = Database::in_memory().unwrap();
    let entry = AuditLogEntry::new(
        "mcp-http",
        "find_local_files",
        json!({"query": "invoice"}),
        AuditStatus::Allowed,
    )
    .with_output(json!({"items": []}))
    .with_duration_ms(9);
    db.insert_audit_entry(&entry).unwrap();

    let jsonl = db.export_audit_entries_jsonl(100).unwrap();
    let lines: Vec<&str> = jsonl.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(value["client_id"], "mcp-http");
    assert_eq!(value["tool_name"], "find_local_files");
}
```

- [x] **Step 2: Run test to verify RED**

Run:

```bash
cargo test -p atools-core --test agent_tests audit_entries_export_as_jsonl
```

Expected: FAIL because `export_audit_entries_jsonl` does not exist.

- [x] **Step 3: Implement export**

Add:

```rust
pub fn export_audit_entries_jsonl(&self, limit: usize) -> Result<String> {
    let entries = self.list_audit_entries(limit)?;
    let mut out = String::new();
    for entry in entries {
        out.push_str(&serde_json::to_string(&entry)?);
        out.push('\n');
    }
    Ok(out)
}
```

Add command:

```rust
#[tauri::command]
pub fn export_audit_entries_jsonl(state: tauri::State<AppState>, limit: Option<usize>) -> Result<String, String>;
```

- [x] **Step 4: Add audit detail UI**

Allow selecting an audit row and display full JSON input/output in `<pre>` blocks. Add an export button that calls `export_audit_entries_jsonl` and copies the returned JSONL text to clipboard.

- [x] **Step 5: Run checks**

Run:

```bash
cargo test -p atools-core --test agent_tests
pnpm check
```

Expected: PASS and zero Svelte diagnostics.

---

### Task 7: Document MCP Client Setup And Verify Release Build

**Files:**
- Create: `/Users/harris/Desktop/atools/docs/agent-mcp-client.md`

- [x] **Step 1: Write docs**

Create `docs/agent-mcp-client.md` with:

```markdown
# ATools MCP Client Setup

ATools starts a local MCP HTTP endpoint on `127.0.0.1` and stores a per-run bearer token in the local settings database. The Agent panel displays the active bind address and token.

## HTTP

Send JSON-RPC requests to:

`http://<bind>/mcp`

Headers:

`Authorization: Bearer <token>`

## stdio

Use the built binary as a stdio proxy:

`/Users/harris/Desktop/atools/target/release/atools --mcp-stdio`

The proxy forwards to the desktop app when the bind address and token are available. If the desktop app is not running, `initialize` and `tools/list` still work from the local static registry, while `tools/call` returns an explicit desktop-not-running error.

## Permission Retry Flow

1. Client calls `tools/call`.
2. ATools may return `isError: true` with `permission_required: true`.
3. User opens the Agent panel and grants the client/tool pair.
4. Client retries the same `tools/call`.
5. ATools writes an audit record for the result.
```

- [x] **Step 2: Verify full workspace**

Run:

```bash
cargo test --workspace
pnpm check
pnpm build
pnpm exec tauri build --bundles app
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | ./target/release/atools --mcp-stdio
```

Expected:
- Rust tests pass.
- Svelte check reports 0 errors and 0 warnings.
- Vite build succeeds.
- Tauri creates `/Users/harris/Desktop/atools/target/release/bundle/macos/ATools 3.0.app`.
- stdio proxy returns `initialize` and `tools/list` responses.

---

## Self-Review

Spec coverage:
- Persisted tool registry: Task 1 and Task 2.
- Per-client/per-tool grants: Task 1 and Task 3.
- UI-visible confirmation requests: Task 4 and Task 5.
- MCP retry behavior: Task 4 and Task 7.
- Audit detail/export: Task 6.
- macOS release verification: Task 7.

Placeholder scan:
- The plan contains no `TBD`, `TODO`, or undefined "implement later" placeholders.

Type consistency:
- Rust `ToolDefinition.enabled` and `plugin_id` map to TypeScript `ToolDefinition`.
- Rust `AgentToolGrant` maps to TypeScript `AgentToolGrant`.
- Rust `PendingAgentToolRequest` maps to TypeScript `PendingAgentToolRequest`.

Execution mode:
- The user asked to write the plan and then implement tasks one by one. Proceed with inline execution using `superpowers:executing-plans`.
