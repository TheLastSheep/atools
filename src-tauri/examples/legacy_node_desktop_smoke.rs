#[path = "support/native_fixture_restoration.rs"]
mod native_fixture_restoration;
#[path = "support/native_fixture_launchservices.rs"]
mod native_fixture_launchservices;

fn main() {
    atools_lib::run_source_build_bootstrap_if_requested();
    if let Err(error) = native_fixture_launchservices::route_target_stdio_if_requested() {
        eprintln!("Native fixture stdio route refused: {error}");
        std::process::exit(2);
    }
    match native_fixture_launchservices::run_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("Native LaunchServices observer failed: {error}");
            std::process::exit(2);
        }
    }
    if let Err(error) = native_fixture_restoration::apply_if_requested() {
        eprintln!("Native fixture restoration experiment refused: {error}");
        std::process::exit(2);
    }
    if let Err(error) = atools_lib::run_legacy_node_desktop_smoke() {
        eprintln!("Isolated native smoke failed: {error}");
        std::process::exit(1);
    }
}
