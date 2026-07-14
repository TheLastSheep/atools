# ATools Agent Instructions

## Codebase Memory

When `codebase-memory-mcp` tools are available, prefer them for structural code exploration:

- Use `index_repository` once per repository before graph queries.
- Use `search_graph` for definitions, classes, routes, implementations, and symbol discovery.
- Use `trace_path` for callers, callees, dependency paths, data flow, and impact analysis.
- Use `get_architecture` before broad refactors or architecture questions.
- Use `get_code_snippet` only after locating the exact symbol through `search_graph`.
- Verify final conclusions against source files and tests before making or claiming changes.

## Product And Engineering North Star

Before planning or implementing work that affects product direction, architecture, Skills, MCP, plugins, task execution, result presentation, Computer Use, Browser Use, or long-term memory, read:

`docs/superpowers/specs/2026-07-14-atools-product-engineering-north-star.md`

The document is an accepted product and engineering boundary, not optional background material.

Key constraints:

- ATools is a high-performance, lightweight, local-first desktop tool runtime and result workspace for humans and external agents.
- Humans use the search/plugin UI; agents use Skills/MCP; both paths must share one capability and execution pipeline.
- ATools is not a general chat assistant, multi-channel personal agent, model-training platform, or replacement for OpenClaw/Hermes.
- Structured tools and native/plugin APIs take priority over Browser Use or Computer Use. Visual computer operation is a fallback.
- Every execution should converge on durable `TaskRun`, `Artifact`, permission, audit, and result-center concepts.
- Long-term memory is scoped execution memory based on validated preferences, corrections, recipes, and recovery experience. Unconfirmed model inference must not become permanent memory.
- Core toolbox features must remain usable without a model, account, remote embedding service, or network connection.
- Rust/Tauri performance is a hypothesis until proven by reproducible startup, hotkey, search, memory, plugin-activation, and package-size benchmarks.
- Release safety and measurable performance take priority over expanding generic Agent functionality.

If a requested change conflicts with the north-star document, stop and surface the conflict before implementation. Update the document and codebase-memory ADR only after the product decision has been explicitly reconsidered.

