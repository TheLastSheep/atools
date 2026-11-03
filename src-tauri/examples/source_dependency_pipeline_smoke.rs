//! Isolated real TaskRun flow for one pinned fixed-HEAD source package.
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("SOURCE_DEPENDENCY_PIPELINE_SMOKE_UNSUPPORTED_PLATFORM");
    std::process::exit(2);
}

#[cfg(target_os = "macos")]
fn main() {
    atools_lib::run_source_build_bootstrap_if_requested();
    if let Err(error) = atools_lib::run_source_dependency_pipeline_smoke() {
        eprintln!("SOURCE_DEPENDENCY_PIPELINE_SMOKE_FAILED:{error}");
        std::process::exit(1);
    }
}
