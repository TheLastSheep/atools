//! Early trusted executable mode. This never starts Tauri, MCP, or plugin code.
pub(crate) const FLAG: &str = "--atools-source-build-bootstrap";

#[cfg(target_os = "macos")]
#[path = "bootstrap_macos.rs"]
mod macos;

/// Must be the first call in every supported host executable entry point.
/// Once requested, malformed/unsupported mode exits; it never falls into GUI.
pub fn run_if_requested() {
    let mut arguments = std::env::args_os();
    let _ = arguments.next();
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(FLAG)) {
        if arguments.any(|argument| argument == FLAG) {
            fail();
        }
        return;
    }
    let mut remaining = Vec::new();
    for argument in arguments {
        if remaining.len() >= 16 {
            fail();
        }
        remaining.push(argument);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = macos::replace(remaining);
    }
    fail();
}

fn fail() -> ! {
    eprintln!("SOURCE_BUILD_BOOTSTRAP_FAILED");
    std::process::exit(70);
}

pub(super) fn executable() -> Result<std::path::PathBuf, String> {
    let executable = std::env::current_exe().map_err(|_| "SourceBuildBootstrapUnavailable")?;
    #[cfg(test)]
    let executable = executable
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or("SourceBuildBootstrapUnavailable")?
        .join("examples/source_build_bootstrap_smoke");
    super::staging::canonical_file(&executable)
        .map_err(|_| "SourceBuildBootstrapUnavailable".into())
}
