use super::*;
use atools_core::error::AToolsError;

#[test]
fn core_conflict_and_closed_session_have_distinct_native_classifications() {
    assert_eq!(
        classify_core_error(&AToolsError::Config(ALIAS_CAS_CONFLICT.into())),
        CoreWriteFailure::RevisionConflict
    );
    assert_eq!(
        classify_core_error(&AToolsError::Config(
            "Renderer command alias session closed before transaction start".into()
        )),
        CoreWriteFailure::SessionClosed
    );
    assert_eq!(
        classify_core_error(&AToolsError::Config("invalid alias candidate".into())),
        CoreWriteFailure::InvalidCandidate
    );
    assert_eq!(
        classify_core_error(&AToolsError::Plugin("database unavailable".into())),
        CoreWriteFailure::Storage
    );
}

#[test]
fn revision_conflicts_and_storage_errors_invalidate_the_native_raw_baseline() {
    assert!(CoreWriteFailure::RevisionConflict.invalidate_base());
    assert!(CoreWriteFailure::Storage.invalidate_base());
    assert!(!CoreWriteFailure::SessionClosed.invalidate_base());
    assert!(!CoreWriteFailure::InvalidCandidate.invalidate_base());
}

#[test]
fn write_chunk_decoder_accepts_the_full_sixteen_kibibyte_chunk() {
    let encoded = STANDARD.encode(vec![7_u8; 16 * 1024]);
    assert_eq!(encoded.len(), MAX_WRITE_CHUNK_BASE64_BYTES);
    assert_eq!(decode_write_chunk(&encoded).unwrap().len(), 16 * 1024);
    assert!(decode_write_chunk(&format!("{encoded}AAAA")).is_err());
}
