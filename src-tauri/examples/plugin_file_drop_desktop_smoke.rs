fn main() {
    if let Err(error) = atools_lib::run_plugin_file_drop_desktop_smoke() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
