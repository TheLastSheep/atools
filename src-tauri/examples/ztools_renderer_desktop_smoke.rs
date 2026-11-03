fn main() {
    atools_lib::run_source_build_bootstrap_if_requested();
    if let Err(error) = atools_lib::run_ztools_renderer_desktop_smoke() {
        eprintln!("Isolated main renderer acceptance failed: {error}");
        std::process::exit(1);
    }
}
