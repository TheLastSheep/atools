# ATools MCP Client Setup

ATools starts a local MCP HTTP endpoint on `127.0.0.1` and stores a per-run bearer token in the local settings database. The Agent panel displays the active bind address and a masked token label.

The Agent panel and Settings -> MCP 服务 both provide copy buttons and safe merge buttons for MCP client configuration. Prefer the generated JSON over hand-editing URLs and tokens; copied HTTP configs include the Bearer token even though the UI masks it.

Both surfaces expose four copyable templates:

- `通用 HTTP MCP`：uses the active `http://127.0.0.1:<port>/mcp` endpoint and bearer token when the desktop server is running.
- `通用 stdio proxy`：starts the installed app with `--mcp-stdio`; useful for clients that only support stdio MCP.
- `Claude Desktop / Claude Code`：copies a Claude-compatible `mcpServers` JSON block, using stdio proxy by default so users do not need to sync ports and tokens.
- `Cursor`：uses HTTP MCP when the desktop server is ready, otherwise falls back to stdio proxy.

## Install Plans

The Agent panel and Settings -> MCP 服务 show an install plan beside every template:

- target client/config location, such as Claude config, Cursor settings, or generic MCP settings.
- merge steps for `mcpServers.atools`.
- the transport-specific checks, such as preserving `Authorization: Bearer <token>` for HTTP or keeping `--mcp-stdio` for stdio.
- a `合并到文件...` action that asks the user to choose or create a target JSON config file.
- a suggested target path for known clients. On macOS, Claude Desktop uses `~/Library/Application Support/Claude/claude_desktop_config.json`; Cursor global MCP config uses `~/.cursor/mcp.json`, with project config still available at `.cursor/mcp.json`.

Safe merge writes are enabled only after the user selects a target file. For known clients, the file picker starts at the suggested config path when the home directory is available. ATools requires explicit confirmation, reads existing JSON when present, creates a same-directory `*.atools-backup-*` copy before changing an existing file, and only replaces or adds `mcpServers.atools`. Other MCP servers and top-level config fields are preserved. Invalid JSON, non-object configs, or non-object `mcpServers` values fail without writing.

## HTTP

Send JSON-RPC requests to:

`http://<bind>/mcp`

Headers:

`Authorization: Bearer <token>`

## stdio

Use the built binary as a stdio proxy:

`/Users/harris/Desktop/atools/target/release/atools --mcp-stdio`

The proxy forwards to the desktop app when the bind address and token are available. If the desktop app is not running, `initialize`, `ping`, `tools/list`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`, and `prompts/get` still work from the local static registry, `notifications/initialized` is accepted without writing a stdout response line, and `tools/call` returns an explicit desktop-not-running error.

The copied stdio config uses the installed app command:

```json
{
  "mcpServers": {
    "atools": {
      "command": "/Applications/ATools 3.0.app/Contents/MacOS/ATools 3.0",
      "args": ["--mcp-stdio"]
    }
  }
}
```

## Claude / Cursor Compatible JSON

ATools templates use the standard `mcpServers` shape:

```json
{
  "mcpServers": {
    "atools": {
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

For clients or modes that do not support HTTP MCP, copy the stdio proxy template instead.

## Lifecycle Notes

- `ping` returns a JSON-RPC success response with an empty result object.
- JSON-RPC messages without an `id` are treated as notifications: HTTP returns `204 No Content`; stdio proxy writes no response line. This includes id-less `tools/call`, which is not executed because no response/audit result can be returned to the client.
- `initialize` declares resources and prompts capabilities; the running desktop server adds enabled local Skills dynamically.
- `resources/list` exposes `atools://agent/tools`, a JSON resource containing the current enabled Agent tool catalog. `resources/read` returns its `application/json` text content.
- `resources/list` also exposes `atools://capabilities`, the unified built-in Tool, plugin Tool, plugin Feature, and Skill discovery contract. Its invocable and availability fields describe the real current entry points; discovery does not bypass `tools/call` permission checks.
- `resources/templates/list` currently returns an empty array without `nextCursor`.
- `prompts/list` exposes the built-in `atools_agent_tool_guide` prompt with an optional `task` argument. `prompts/get` returns one user message with local Agent tool-selection guidance and includes the provided task text when present.
- When the desktop app is running, `resources/list` also exposes `atools://skills`, `resources/templates/list` exposes `atools://skills/{skillId}`, and `prompts/list` exposes one `atools_skill_<skillId>` prompt per enabled local Skill. Every Skill prompt states that tool permissions are still checked on each call.
- JSON-RPC batch requests are supported over HTTP MCP and stdio fallback. Mixed batches omit notification responses and return an array for requests with IDs; notification-only batches produce no response body/line. Empty batches return `-32600 Invalid Request`.

## Durable Task Calls

The running desktop HTTP server implements the experimental MCP Tasks contract from protocol revision `2025-11-25`. Its `initialize` response declares `tasks.requests.tools.call` and `tasks.cancel`, and every enabled tool returned by `tools/list` declares `execution.taskSupport: "optional"`. The static stdio fallback does not advertise Tasks; when stdio can forward to a running desktop app, it receives the desktop server's capabilities.

Existing short calls stay synchronous. To avoid holding the original `tools/call` request open for a long operation, include a `task` object:

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "find_local_files",
    "arguments": { "root": "/Users/example", "query": "report" },
    "task": { "ttl": 60000 }
  }
}
```

ATools immediately returns a task whose `taskId` is the durable `TaskRun.runId`. Requested TTL values are currently overridden with `ttl: null`, so persisted task results have no automatic expiry. Poll `tasks/get` at or above the returned `pollInterval`; ATools maps created/running to `working`, permission confirmation to `input_required`, success/partial to `completed`, and preserves `failed` and `cancelled` terminal states.

Use `tasks/result` after the task reaches a terminal status. It returns the same `CallToolResult` envelope as a synchronous call, including `structuredContent.runId`, status, summary, metrics, artifacts, validation, and result URL, plus the standard related-task metadata. Calling `tasks/result` before a terminal state waits for completion, as required by the Tasks contract.

Use `tasks/cancel` for a non-terminal task. ATools aborts executions started by the tracked background executor, removes pending permission requests, persists `cancelled` before replying, and prevents a late executor result from replacing that terminal state. Cancelling an already-terminal or unknown task returns JSON-RPC `-32602`.

Task lookup is scoped to the authenticated desktop MCP context. A task created through another local UI/client surface is not exposed through these MCP task methods.

## Built-in Context Tool

The built-in `get_current_context` tool attempts to read the current browser URL and Finder folder path through the same macOS command-layer bridges used by the plugin context surface. When a supported frontmost browser exposes a URL, the tool returns `browser_url`; otherwise it returns `browser_url:null` with an explicit unavailable or bridge-error reason. For Finder context, `finder_path` follows the command-layer folder bridge, including the Desktop fallback when Finder has no open windows, or returns an explicit bridge-error reason.

## Built-in Open Tools

`open_url` only accepts explicit `http` or `https` addresses. It and `open_or_reveal_path` both enter the permission, TaskRun, audit, and result-center pipeline. The desktop search UI reuses these same capabilities for web quick open, direct URL open, local launch, and local application results.

## Built-in File Search Tool

The built-in `find_local_files` tool supports directory-name ignores through `ignore_dirs` and wildcard ignores through `ignore_patterns`. Patterns match both filenames and root-relative slash paths; examples include `*.tmp` for temporary files and `generated/**` for an ignored subtree. These filters are applied during traversal, so ignored directories are skipped before recursion.

## Plugin Manifest Tools

Enabled plugin-declared tools execute through the plugin runtime after the user enables and authorizes the normalized `plugin_<plugin>_<tool>` entry. ATools supports handlers registered with `utools.registerTool`, including sync handlers and async/Promise handlers that await plugin IPC APIs such as `utools.dbStorage`.

If a plugin Agent tool is called before its UI/runtime context has been opened, ATools lazy-loads the plugin manifest `preload` from the installed plugin directory and retries the handler call. Absolute preload paths and `..` paths are rejected before reading from disk.

## Permission Retry Flow

1. Client calls `tools/call`.
2. ATools may return `isError: true` with `permission_required: true`.
3. User confirms through the Agent permission dialog or opens the Agent panel and grants the client/tool pair.
4. Client retries the same `tools/call`.
5. ATools writes an audit record for the result.

## Current Limitations

- The first denied call is not held open. Clients should retry after the user grants the tool.
- MCP Tasks are the experimental `2025-11-25` protocol shape. Clients should negotiate the advertised capabilities and tool-level `taskSupport` instead of assuming Tasks are available from the static fallback.
- Plugin-declared tools are executable through MCP/Agent when the plugin manifest, preload, and `utools.registerTool` handler are compatible. More real third-party plugin tool compatibility regression and client matrix testing are still needed.
- OCR depends on a local OCR endpoint at `127.0.0.1:8765`.
- Image compression supports the default original-format output and explicit `format: "webp"` lossless WebP output. Batch calls preserve one result per path: failed paths use `status: "failed"` without discarding successful outputs, produce a partial/failed TaskRun, and can be retried alone from the result center. `max_bytes` is still a best-effort target and returns `target_met` / `target_reason`; WebP output does not perform lossy quality tuning yet.
