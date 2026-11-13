//! Headless CLI & MCP Daemon (`atools_cli`) — Plan D Convergence.
//!
//! Provides a lightweight, zero-WebView command-line and MCP JSON-RPC interface
//! backed directly by `atools-core` (`Database`, `FeatureSearchIndex`, `HarnessSpec`,
//! `builtin_skills`, and `mcp::handle_json_rpc`).

use std::io::{BufRead, Write};

use atools_core::agent::ToolRegistry;
use atools_core::config::AppConfig;
use atools_core::db::Database;
use atools_core::harness::{builtin_skills, canonicalize_json, HarnessSpec};
use atools_core::mcp::{handle_mcp_message_with_skills, McpToolCallResult};
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let subcommand = args.first().map(String::as_str).unwrap_or("help");

    match subcommand {
        "harness" => {
            let spec = HarnessSpec::current();
            let value = canonicalize_json(&serde_json::to_value(spec).unwrap_or_default());
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
        }
        "skills" => {
            let skills = builtin_skills();
            let value = canonicalize_json(&serde_json::to_value(skills).unwrap_or_default());
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
        }
        "search" => {
            let query = args.get(1).map(String::as_str).unwrap_or("");
            let db = open_db();
            let matches = match db
                .feature_catalog_snapshot()
                .and_then(|catalog| catalog.search_checked(query))
            {
                Ok(matches) => matches,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            };
            let output: Vec<_> = matches
                .into_iter()
                .map(|m| {
                    json!({
                        "featureCode": m.feature_code,
                        "pluginId": m.plugin_id,
                        "score": m.score,
                        "matchType": m.match_type
                    })
                })
                .collect();
            println!(
                "{}",
                serde_json::to_string_pretty(&output).unwrap_or_default()
            );
        }
        "mcp-stdio" => {
            let registry = ToolRegistry::default();
            let skills = builtin_skills();
            let stdin = std::io::stdin();
            let mut stdout = std::io::stdout();
            for line in stdin.lock().lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if let Some(resp) =
                    handle_mcp_message_with_skills(&registry, &skills, req, |call| {
                        McpToolCallResult::error_for_tool(
                            &call.name,
                            "Use ATools desktop host or plugin bridge for live tool execution",
                        )
                    })
                {
                    let _ = writeln!(stdout, "{}", resp);
                    let _ = stdout.flush();
                }
            }
        }
        _ => {
            println!(
                "ATools Headless CLI & MCP Daemon (v{})\n\
                 Usage:\n  \
                   atools_cli search <query>   Search indexed features using zero-alloc FeatureSearchIndex\n  \
                   atools_cli harness          Print canonicalized AI-Native Harness specification\n  \
                   atools_cli skills           Print built-in declarative SOP skills\n  \
                   atools_cli mcp-stdio        Run headless MCP JSON-RPC server over stdio",
                env!("CARGO_PKG_VERSION")
            );
        }
    }
}

fn open_db() -> Database {
    if let Ok(config) = AppConfig::new() {
        let _ = config.ensure_dirs();
    }
    Database::new().unwrap_or_else(|_| Database::in_memory().expect("in-memory db"))
}
