//! Run every independent owner teardown even when another owner fails.
pub(super) fn run(
    mut general: impl FnMut(bool) -> Result<(), String>,
    feature: impl FnOnce() -> Result<(), String>,
    main: impl FnOnce() -> Result<(), String>,
    stack: impl FnOnce() -> Result<(), String>,
    shelf: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    let first = general(false);
    collect(&mut errors, feature());
    let main_result = main();
    let main_withdrawn = main_result.is_ok();
    collect(&mut errors, main_result);
    let general_result = if main_withdrawn
        && first.as_ref().err().map(String::as_str) == Some("SETTINGS_HOTKEY_RECORDING_BUSY")
    {
        general(true)
    } else {
        first
    };
    collect(&mut errors, general_result);
    collect(&mut errors, stack());
    collect(&mut errors, shelf());
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
fn collect(errors: &mut Vec<String>, result: Result<(), String>) {
    if let Err(error) = result {
        errors.push(error);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn general_failure_does_not_skip_other_owners() {
        let calls = RefCell::new(Vec::new());
        let result = run(
            |_| {
                calls.borrow_mut().push("general");
                Err("withdraw failed".into())
            },
            || {
                calls.borrow_mut().push("feature");
                Ok(())
            },
            || {
                calls.borrow_mut().push("main");
                Ok(())
            },
            || {
                calls.borrow_mut().push("stack");
                Ok(())
            },
            || {
                calls.borrow_mut().push("shelf");
                Ok(())
            },
        );
        assert!(result.is_err());
        assert_eq!(
            *calls.borrow(),
            ["general", "feature", "main", "stack", "shelf"]
        );
    }
    #[test]
    fn borrowed_held_retries_only_after_confirmed_main_withdrawal() {
        let calls = RefCell::new(Vec::new());
        assert!(run(
            |withdrawn| {
                calls.borrow_mut().push(withdrawn);
                if withdrawn {
                    Ok(())
                } else {
                    Err("SETTINGS_HOTKEY_RECORDING_BUSY".into())
                }
            },
            || Ok(()),
            || Ok(()),
            || Ok(()),
            || Ok(()),
        )
        .is_ok());
        assert_eq!(*calls.borrow(), [false, true]);
    }
}
