pub mod agent;
pub mod ai_service;
pub mod capability;
pub mod config;
pub mod db;
pub mod error;
pub mod feature_catalog;
pub mod harness;
pub mod matcher;
pub mod mcp;
pub mod memory;
pub mod models;
pub mod pasteboard;
mod plugin_presentation;
pub mod schema_ui;
pub mod skill;
pub mod task_run;
pub mod task_run_output;
pub mod utils;

pub use config::AppConfig;
pub use db::Database;
pub use error::{AToolsError, Result};
pub use harness::{
    builtin_skills, canonicalize_json, prune_tool_output, DangerousCommandGuard, ErrorObservation,
    HarnessSpec, PromptSanitizer, SafetyVerdict,
};
pub use matcher::{
    search_all, to_pinyin_full, to_pinyin_initials, FeatureSearchIndex, MatchResult,
};
pub use models::*;
pub use pasteboard::*;
pub use utils::{generate_rev, iso_days_ago, now_iso, sanitize_id};
