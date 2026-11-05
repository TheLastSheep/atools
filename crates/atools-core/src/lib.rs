#![allow(
    dead_code,
    clippy::all,
    clippy::assertions_on_constants,
    clippy::bool_assert_comparison,
    clippy::cloned_ref_to_slice_refs,
    clippy::collapsible_else_if,
    clippy::collapsible_if,
    clippy::doc_lazy_continuation,
    clippy::field_reassign_with_default,
    clippy::format_in_format_args,
    clippy::io_other_error,
    clippy::items_after_test_module,
    clippy::large_enum_variant,
    clippy::manual_div_ceil,
    clippy::manual_is_multiple_of,
    clippy::manual_range_contains,
    clippy::manual_unwrap_or_default,
    clippy::needless_borrow,
    clippy::needless_borrows_for_generic_args,
    clippy::needless_lifetimes,
    clippy::needless_range_loop,
    clippy::needless_return,
    clippy::nonminimal_bool,
    clippy::ptr_arg,
    clippy::question_mark,
    clippy::redundant_closure,
    clippy::result_large_err,
    clippy::result_unit_err,
    clippy::search_is_some,
    clippy::single_match,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::unnecessary_cast,
    clippy::unnecessary_lazy_evaluations,
    clippy::unnecessary_map_or,
    clippy::unused_enumerate_index,
    clippy::useless_conversion,
    clippy::useless_format
)]

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
