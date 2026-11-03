fn main() {
    if let Err(error) = atools_lib::run_official_market_target_probe() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
