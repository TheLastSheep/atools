# CLAUDE.md — ATools AI Agent & Engineering Guide

Please read and follow [`AGENTS.md`](./AGENTS.md) and [`DESIGN.md`](./DESIGN.md) as the authoritative engineering instructions for this repository.

## Quick Reference

- **Architecture & Design Spec**: [`DESIGN.md`](./DESIGN.md)
- **Product & Engineering North Star**: [`docs/superpowers/specs/2026-07-14-atools-product-engineering-north-star.md`](./docs/superpowers/specs/2026-07-14-atools-product-engineering-north-star.md)
- **Agent Harness Implementation**: [`crates/atools-core/src/harness.rs`](./crates/atools-core/src/harness.rs)
- **MCP Server & Progressive Disclosure**: [`crates/atools-core/src/mcp.rs`](./crates/atools-core/src/mcp.rs)
- **Zero-Allocation Matcher & Pinyin/Regex Engine**: [`crates/atools-core/src/matcher.rs`](./crates/atools-core/src/matcher.rs)
- **SQLite WAL & Cached Prepared Statements**: [`crates/atools-core/src/db.rs`](./crates/atools-core/src/db.rs)
- **ZTools 3-Tier Compatibility Classifier**: [`crates/atools-plugin/src/loader.rs`](./crates/atools-plugin/src/loader.rs)

## Essential Commands

```bash
# Run core, plugin, and API shim test suites
cargo test -p atools-core -p atools-plugin -p atools-api-shim

# Run AI Harness evaluation tests
cargo test -p atools-core --test harness_eval_tests

# Run ZTools plugin ecosystem compatibility audit (161 builtin + 166 ZTools-plugins)
cargo test -p atools-plugin --test test_all_builtin -- --nocapture

# Check full workspace including Tauri desktop host
cargo check --workspace
```
