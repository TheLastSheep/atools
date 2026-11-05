// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code, clippy::all)]

fn main() {
    atools_lib::run_source_build_bootstrap_if_requested();
    if std::env::args().any(|arg| arg == "--mcp-stdio") {
        if let Err(error) = atools_lib::run_mcp_stdio_proxy() {
            eprintln!("{}", error);
            std::process::exit(1);
        }
        return;
    }

    atools_lib::run();
}
