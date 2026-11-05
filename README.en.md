<div align="center">

<img src="public/logo.svg" alt="ATools Logo" width="112" height="112" />

# ATools 3.0

**Local-First AI-Native Desktop Launcher & Cross-Platform Plugin Runtime Built with Rust + Tauri v2**  
Seamless **uTools / ZTools** Ecosystem Compatibility · Zero-Alloc Sub-Millisecond Search · Native **MCP + Skills + Agent Harness**

[![CI](https://github.com/TheLastSheep/atools/actions/workflows/ci.yml/badge.svg)](https://github.com/TheLastSheep/atools/actions/workflows/ci.yml)
[![Release & Packages](https://github.com/TheLastSheep/atools/actions/workflows/publish.yml/badge.svg)](https://github.com/TheLastSheep/atools/actions/workflows/publish.yml)
[![Version](https://img.shields.io/badge/version-3.0.0-645cf0.svg)](https://github.com/TheLastSheep/atools/releases)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24c8db.svg)](https://v2.tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-dea584.svg)](https://www.rust-lang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-a650e2.svg)](./LICENSE)

[**简体中文**](./README.md) | [**English**](./README.en.md) | [**Architecture (DESIGN.md)**](./DESIGN.md) | [**Third-Party Notices**](./THIRD_PARTY_NOTICES.md)

</div>

---

## 1. Overview

**ATools 3.0** is a local-first desktop launcher, cross-platform plugin runtime, and AI-Native capability workspace built on **Rust + Tauri v2 + SQLite WAL**, featuring an embedded QuickJS sandbox and an on-demand Node.js compatibility runtime.

- **Extreme Rust Performance**: Zero-allocation ASCII matching, compile-time static Pinyin indexing across 20,902+ Unicode CJK characters, and a 100,000-entry search index with **`~0.1 ms`** P99 latency.
- **Dual-Namespace Plugin Compatibility**: First-class `window.utools` and `window.ztools` bidirectional API parity (125+ host API methods plus prototype-chain stand-in probes), running unmodified uTools/ZTools plugins alongside 40+ built-in workbench plugins.
- **AI-Native Workspace**: Built-in local **MCP (Model Context Protocol) Server**, **Skills Registry**, and **Agent Harness** with fine-grained permission gates, prompt sanitization, and full audit trails for Claude Code, Cursor, and Codex.
- **Local-First & Self-Hostable Sync**: All documents, clipboard history, settings, and plugin storage live in a local SQLite WAL database with optional AES-GCM encrypted WebDAV sync and a standalone Rust/Axum sync server (`atools-sync-server`).

---

## 2. Architecture

```mermaid
flowchart TB
    subgraph Entry["Dual Entry Layer (Human + AI Agent)"]
        HumanUI["Human UI\n(Tauri v2 Native Window / Global Hotkey / Floating Ball / Super Panel)"]
        AgentMCP["External AI Agents\n(Claude Code / Cursor / Codex via Local MCP Server)"]
    end

    subgraph Core["ATools Rust Core (crates/atools-core)"]
        Matcher["Zero-Alloc Search Engine\n(20,902+ CJK Pinyin + Regex Cache + ASCII Bitmask Filter)"]
        Harness["AI-Native Harness\n(Permission Gate + Prompt Sanitizer + Error-as-Observation)"]
        DB["SQLite WAL Engine\n(prepare_cached + 256MB mmap + Docs / Blobs / Audit Logs)"]
        TaskRun["Unified Execution Pipeline\n(TaskRun State Machine + Artifacts + Scoped Memory)"]
    end

    subgraph Runtime["3-Tier Hybrid Plugin & System Runtime"]
        Tier0["Tier 0: Native Rust Capabilities\n(App Scanner / Clipboard Watcher / Screen Capture & Color Picker / Native OCR)"]
        Tier1["Tier 1: WebView Direct Bridge\n(window.ztools & window.utools Parity + 111+ Stand-In Probes)"]
        Tier2["Tier 2: QuickJS Preload Sandbox + On-Demand Node/Electron CJS Sidecar\n(rquickjs + Isolated Worker JSON-RPC / Sync HTTP Bridge)"]
    end

    HumanUI --> Matcher
    HumanUI --> TaskRun
    AgentMCP --> Harness
    Harness --> TaskRun
    Matcher --> DB
    TaskRun --> DB
    TaskRun --> Tier0
    TaskRun --> Tier1
    TaskRun --> Tier2
```

---

## 3. Quick Start

### Prerequisites

- **Rust**: `1.80+` (`cargo`, `rustfmt`, `clippy`)
- **Node.js**: `22+`
- **Package Manager**: `pnpm 11+`
- **Platform Toolchain**: Follow [Tauri v2 Prerequisites](https://v2.tauri.app/start/prerequisites/) for macOS, Windows, or Linux.

### Development & Build

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Start desktop development mode
pnpm tauri dev

# Build production desktop bundles
pnpm build:ztools-updater
pnpm build
pnpm tauri build
```

### Verification & Benchmarks

```bash
pnpm check
pnpm test:unit
pnpm audit:host-api-surface
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
pnpm test:rust
pnpm benchmark:search:ci
```

---

## 4. License

Distributed under the [**MIT License**](./LICENSE). See [**THIRD_PARTY_NOTICES.md**](./THIRD_PARTY_NOTICES.md) for third-party attributions and upstream bundle licenses.
