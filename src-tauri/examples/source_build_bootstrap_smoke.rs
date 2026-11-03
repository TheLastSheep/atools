//! Fixed test-only entry: never launches the desktop or accepts a replacement executable.
fn main() {
    atools_lib::run_source_build_bootstrap_if_requested();
    std::process::exit(64);
}
