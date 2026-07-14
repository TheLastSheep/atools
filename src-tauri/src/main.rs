// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--mcp-stdio") {
        if let Err(error) = atools_lib::run_mcp_stdio_proxy() {
            eprintln!("{}", error);
            std::process::exit(1);
        }
        return;
    }

    atools_lib::run();
}
