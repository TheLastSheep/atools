pub(super) fn validate_exit_codes(
    run_return_code: i32,
    fixture_exit_code: i32,
) -> Result<(), String> {
    if run_return_code == 0 && fixture_exit_code == 0 {
        return Ok(());
    }
    Err(format!(
        "Isolated main renderer acceptance did not pass (run_return={run_return_code}, fixture={fixture_exit_code})"
    ))
}

#[cfg(test)]
mod exit_status_tests {
    use super::validate_exit_codes;

    #[test]
    fn accepts_only_matching_success_codes() {
        assert!(validate_exit_codes(0, 0).is_ok());
        assert!(validate_exit_codes(0, 1).is_err());
        assert!(validate_exit_codes(1, 0).is_err());
    }

    #[test]
    fn rejects_matching_nonzero_codes() {
        assert!(validate_exit_codes(1, 1).is_err());
        assert!(validate_exit_codes(2, 2).is_err());
    }
}
