//! LaunchServices-only observer for the private native editor fixture.
//! The ordinary smoke launch path remains the existing direct-spawn path.

#[cfg(target_os = "macos")]
#[path = "native_fixture_launchservices/guard.rs"]
mod guard;
#[cfg(target_os = "macos")]
#[path = "native_fixture_launchservices/lifecycle.rs"]
mod lifecycle;
#[cfg(target_os = "macos")]
#[path = "native_fixture_launchservices/process.rs"]
mod process;
#[cfg(target_os = "macos")]
#[path = "native_fixture_launchservices/protocol.rs"]
mod protocol;
#[cfg(target_os = "macos")]
#[path = "native_fixture_launchservices/stdio.rs"]
mod stdio;

#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(target_os = "macos")]
pub fn run_if_requested() -> Result<bool, String> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--atools-native-launchservices-observer") {
        return Ok(false);
    }
    let config = guard::read_observer_config(&args)?;
    let fifo = stdio::create_private_fifo(&config.control_dir, &config.run_id)?;
    let result = lifecycle::launch_and_observe(&config, &fifo);
    let _ = std::fs::remove_file(&fifo);
    match result {
        Ok(report) => {
            protocol::write_report(&config.observer_report_path, &report)?;
            println!("AToolsNativeLaunchServicesResult {}", serde_json::to_string(&report)
                .map_err(|error| format!("serialize observer report: {error}"))?);
            Ok(true)
        }
        Err(error) => {
            let report = protocol::ObserverReport::failed(&config, error);
            protocol::write_report(&config.observer_report_path, &report)?;
            println!("AToolsNativeLaunchServicesResult {}", serde_json::to_string(&report)
                .map_err(|error| format!("serialize observer report: {error}"))?);
            Ok(true)
        }
    }
}

/// Target-only stdio route. The FIFO is created by the identity-bound observer.
#[cfg(target_os = "macos")]
pub fn route_target_stdio_if_requested() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let path = std::env::var_os("ATOOLS_NATIVE_STDIO_FIFO");
    if !guard::launchservices_route_required(&args, path.is_some())? { return Ok(()); }
    let Some((case_id, run_id)) = guard::active_input_identity(&args)? else {
        return Err("private stdio routing requires the explicit native editor fixture flags".into());
    };
    // The run-bound FIFO is a one-use LaunchServices permit: a late target
    // cannot enter Tauri when the observer has removed it or stopped reading.
    let path = path.ok_or("LaunchServices fixture permit is missing")?;
    let bundle_id = objc2_foundation::NSBundle::mainBundle().bundleIdentifier()
        .map(|value| value.to_string()).ok_or("fixture main bundle identifier unavailable")?;
    let expected = format!("dev.atools.fixture.dialog.{}", run_id.replace('-', ""));
    if bundle_id != expected || !matches!(case_id.as_str(), "local-plain-text" | "local-json-editor") {
        return Err("private stdio route bundle/case identity mismatch".into());
    }
    stdio::route_process_stdio(&PathBuf::from(path), &run_id)?;
    stdio::emit_target_environment_observation(&run_id)
}

#[cfg(not(target_os = "macos"))]
pub fn run_if_requested() -> Result<bool, String> {
    if std::env::args().any(|arg| arg == "--atools-native-launchservices-observer") {
        return Err("LaunchServices fixture mode is available only on macOS".into());
    }
    Ok(false)
}

#[cfg(not(target_os = "macos"))]
pub fn route_target_stdio_if_requested() -> Result<(), String> {
    if std::env::var_os("ATOOLS_NATIVE_STDIO_FIFO").is_some() {
        return Err("private fixture stdio routing is available only on macOS".into());
    }
    Ok(())
}
