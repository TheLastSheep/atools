//! Addresses are valid identity only while the native adapter retains the owned object.
pub(super) fn accepts(owned: Option<usize>, observed: usize, own_install: bool) -> bool {
    observed != 0
        && match owned {
            Some(owned) => owned == observed,
            None => own_install,
        }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_id_and_properties_do_not_authorize_a_replaced_native_instance() {
        assert!(accepts(None, 10, true));
        assert!(accepts(Some(10), 10, false));
        assert!(!accepts(Some(10), 11, false));
        assert!(!accepts(None, 11, false));
        assert!(accepts(None, 11, true));
    }
}
