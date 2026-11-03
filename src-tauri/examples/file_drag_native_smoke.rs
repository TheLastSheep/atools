use std::path::PathBuf;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let Some(root) = args.next().map(PathBuf::from) else {
        eprintln!("usage: file_drag_native_smoke <new-path-under-TMPDIR>");
        std::process::exit(2);
    };
    if args.next().is_some() {
        eprintln!("expected exactly one scratch root argument");
        std::process::exit(2);
    }

    if let Err(error) = atools_lib::run_file_drag_native_smoke(root) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
