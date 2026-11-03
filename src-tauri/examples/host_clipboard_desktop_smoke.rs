fn main() {
    if let Err(error) = atools_lib::run_host_clipboard_desktop_smoke() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
