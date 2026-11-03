use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

use super::metadata::{self, CompressedMetadata, PayloadMetadata, RuntimePin};
use super::{macos, CachedNode, NodeRuntimeCacheError as Error, NodeTarget, RuntimeSignaturePolicy, RuntimeSignatureVerifier};

struct Fixture {
    _root: tempfile::TempDir,
    resources: PathBuf,
    cache_base: PathBuf,
    bytes: Vec<u8>,
    target: NodeTarget,
    policy: RuntimeSignaturePolicy,
    pin_bytes: Vec<u8>,
}

struct SyntheticVerifier {
    sha256: String,
    bytes: u64,
    calls: AtomicUsize,
}

impl RuntimeSignatureVerifier for SyntheticVerifier {
    fn verify_signed_binary(&self, _path: &Path, opened: &std::fs::File, target: NodeTarget,
        team: &str, entitlements: &str, cancelled: &AtomicBool) -> Result<(), ()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if cancelled.load(Ordering::Acquire) { return Err(()); }
        if target != NodeTarget::Aarch64AppleDarwin || team != "HX7739G8FX"
            || entitlements != self.policy_entitlements() { return Err(()); }
        let mut file = opened.try_clone().map_err(|_| ())?;
        file.seek(SeekFrom::Start(0)).map_err(|_| ())?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0; 8192];
        loop {
            let count = file.read(&mut buffer).map_err(|_| ())?;
            if count == 0 { break; }
            bytes += count as u64;
            hash.update(&buffer[..count]);
        }
        if bytes == self.bytes && format!("{:x}", hash.finalize()) == self.sha256 { Ok(()) } else { Err(()) }
    }
}

impl SyntheticVerifier {
    fn policy_entitlements(&self) -> String { TEST_ENTITLEMENTS_SHA.to_string() }
}

const TEST_ENTITLEMENTS_SHA: &str = "3726221a606dae99b53f3f561754842b0e18fad422c134479e4a5fa9a5f466a4";

fn sha(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let resources = root_path.join("resources");
    fs::create_dir(&resources).unwrap();
    let target = NodeTarget::Aarch64AppleDarwin;
    let policy = RuntimeSignaturePolicy { expected_team_id: "HX7739G8FX".into(), approved_entitlements_sha256: TEST_ENTITLEMENTS_SHA.into() };
    let bytes: Vec<u8> = (0..metadata::MIN_SIGNED_BINARY_BYTES as usize + 97).map(|index| ((index * 31 + 7) % 251) as u8).collect();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&bytes).unwrap();
    let compressed = encoder.finish().unwrap();
    let original_pin_bytes = include_bytes!("../../../../resources/node-runtime/pin.json");
    let mut pin_value: serde_json::Value = serde_json::from_slice(original_pin_bytes).unwrap();
    let license = b"synthetic license fixture";
    pin_value["targets"]["aarch64-apple-darwin"]["licenseSha256"] = serde_json::Value::String(sha(license));
    let mut pin_bytes = serde_json::to_vec_pretty(&pin_value).unwrap();
    pin_bytes.push(b'\n');
    let pin: RuntimePin = serde_json::from_slice(&pin_bytes).unwrap();
    let selected = &pin.targets.arm64;
    let metadata = PayloadMetadata {
        schema_version: 2, version: pin.version.clone(), target: target.as_str().into(),
        minimum_macos: pin.minimum_macos.clone(), pin_sha256: sha(&pin_bytes), archive: selected.archive.clone(),
        archive_url: format!("https://nodejs.org/dist/{}/{}", pin.version, selected.archive),
        archive_sha256: selected.sha256.clone(), upstream_binary_sha256: selected.binary_sha256.clone(),
        upstream_binary_bytes: selected.binary_bytes, license_sha256: selected.license_sha256.clone(),
        publisher_team_id: policy.expected_team_id.clone(), entitlements_sha256: policy.approved_entitlements_sha256.clone(),
        signed_binary_sha256: sha(&bytes), signed_binary_bytes: bytes.len() as u64,
        compressed: CompressedMetadata { format: "gzip".into(), level: 6, file: format!("node-{}.gz", target.as_str()), sha256: sha(&compressed), bytes: compressed.len() as u64 },
    };
    let mut metadata_bytes = serde_json::to_vec_pretty(&metadata).unwrap(); metadata_bytes.push(b'\n');
    fs::write(resources.join("compressed-runtime.json"), metadata_bytes).unwrap();
    fs::write(resources.join("NODE-LICENSE"), license).unwrap();
    fs::write(resources.join(format!("node-{}.gz", target.as_str())), compressed).unwrap();
    Fixture { _root: root, resources: resources.canonicalize().unwrap(), cache_base: root_path, bytes, target, policy, pin_bytes }
}

fn verifier(fixture: &Fixture) -> Arc<SyntheticVerifier> {
    Arc::new(SyntheticVerifier { sha256: sha(&fixture.bytes), bytes: fixture.bytes.len() as u64, calls: AtomicUsize::new(0) })
}

fn ensure(f: &Fixture, verifier: &dyn RuntimeSignatureVerifier, cancelled: &AtomicBool) -> Result<CachedNode, Error> {
    macos::ensure_at_with_pin(&f.resources, &f.cache_base, &f.pin_bytes, f.target, &f.policy, verifier, cancelled)
}


struct CancellingVerifier;

impl RuntimeSignatureVerifier for CancellingVerifier {
    fn verify_signed_binary(
        &self, _path: &Path, _opened: &std::fs::File, _target: NodeTarget,
        _team: &str, _entitlements: &str, cancelled: &AtomicBool,
    ) -> Result<(), ()> {
        cancelled.store(true, Ordering::Release);
        Ok(())
    }
}

#[test]
fn cancellation_during_signature_verification_removes_unpublished_cache_file() {
    let f = fixture();
    let cancelled = AtomicBool::new(false);
    assert!(matches!(ensure(&f, &CancellingVerifier, &cancelled), Err(Error::Cancelled)));
    assert!(cancelled.load(Ordering::Acquire));
    let cache = f.cache_base.join("dev.atools.desktop/node-runtime");
    let names = fs::read_dir(cache).unwrap().map(|entry| entry.unwrap().file_name()).collect::<Vec<_>>();
    assert!(names.iter().all(|name| !name.to_string_lossy().ends_with(".tmp") && !name.to_string_lossy().ends_with(".bin")));
}

#[test]
fn cancelled_warm_verification_preserves_the_existing_cache_entry() {
    let f = fixture();
    let verified = verifier(&f);
    let not_cancelled = AtomicBool::new(false);
    let cached = ensure(&f, verified.as_ref(), &not_cancelled).unwrap();
    let cancelled = AtomicBool::new(false);
    assert!(matches!(ensure(&f, &CancellingVerifier, &cancelled), Err(Error::Cancelled)));
    assert!(cancelled.load(Ordering::Acquire));
    assert_eq!(fs::read(&cached.path).unwrap(), f.bytes);
}

#[test]
fn cold_publish_and_warm_hit_rehash_and_reverify_signature() {
    let f = fixture(); let verifier = verifier(&f); let cancel = AtomicBool::new(false);
    let cold = ensure(&f, verifier.as_ref(), &cancel).unwrap();
    assert_eq!(fs::read(&cold.path).unwrap(), f.bytes);
    let warm = ensure(&f, verifier.as_ref(), &cancel).unwrap();
    assert_eq!(cold, warm);
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 2, "synthetic signature callback runs on cold and warm paths; this is not release-signature evidence");
}

#[test]
fn rejects_corrupt_cache_entries_and_does_not_replace_them() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(); let verifier = verifier(&f); let cancel = AtomicBool::new(false);
    let cached = ensure(&f, verifier.as_ref(), &cancel).unwrap();
    fs::set_permissions(&cached.path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&cached.path, b"corrupt replacement").unwrap();
    fs::set_permissions(&cached.path, fs::Permissions::from_mode(0o500)).unwrap();
    assert!(matches!(ensure(&f, verifier.as_ref(), &cancel), Err(Error::InvalidCacheEntry)));
    assert_eq!(fs::read(&cached.path).unwrap(), b"corrupt replacement");
}

#[cfg(unix)]
#[test]
fn refuses_resource_and_private_cache_symlinks() {
    use std::os::unix::fs::symlink;
    let f = fixture(); let first_verifier = verifier(&f); let cancel = AtomicBool::new(false);
    let gz = f.resources.join(format!("node-{}.gz", f.target.as_str()));
    let moved = f._root.path().join("payload.saved"); fs::rename(&gz, &moved).unwrap(); symlink(&moved, &gz).unwrap();
    assert!(ensure(&f, first_verifier.as_ref(), &cancel).is_err());

    let f2 = fixture(); let verifier2 = verifier(&f2);
    symlink(f2._root.path(), f2.cache_base.join("dev.atools.desktop")).unwrap();
    assert!(ensure(&f2, verifier2.as_ref(), &cancel).is_err());
}

#[test]
fn rejects_license_bytes_that_differ_from_the_test_pinned_digest() {
    let f = fixture(); let verifier = verifier(&f); let cancel = AtomicBool::new(false);
    fs::write(f.resources.join("NODE-LICENSE"), b"changed license bytes").unwrap();
    assert!(matches!(ensure(&f, verifier.as_ref(), &cancel), Err(Error::InvalidPayload)));
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 0);
    assert!(!f.cache_base.join("dev.atools.desktop/node-runtime").exists());
}

#[test]
fn cancellation_before_work_does_not_create_cache_or_fallback() {
    let f = fixture(); let verifier = verifier(&f); let cancel = AtomicBool::new(true);
    assert!(matches!(ensure(&f, verifier.as_ref(), &cancel), Err(Error::Cancelled)));
    assert!(!f.cache_base.join("dev.atools.desktop").exists());
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn concurrent_callers_share_one_no_replace_publication() {
    let f = fixture(); let verifier = verifier(&f); let cancel = AtomicBool::new(false);
    let first = std::thread::scope(|scope| {
        let a = scope.spawn(|| ensure(&f, verifier.as_ref(), &cancel).unwrap());
        let b = scope.spawn(|| ensure(&f, verifier.as_ref(), &cancel).unwrap());
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(first.0, first.1);
    let entries = fs::read_dir(f.cache_base.join("dev.atools.desktop/node-runtime")).unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert_eq!(entries.iter().filter(|name| name.ends_with(".bin")).count(), 1);
    assert_eq!(entries.iter().filter(|name| name.ends_with(".tmp")).count(), 0);
}

#[test]
fn refuses_non_private_existing_cache_directory() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(); let verifier = verifier(&f); let cancel = AtomicBool::new(false);
    let _ = ensure(&f, verifier.as_ref(), &cancel).unwrap();
    let runtime_cache = f.cache_base.join("dev.atools.desktop/node-runtime");
    fs::set_permissions(&runtime_cache, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(ensure(&f, verifier.as_ref(), &cancel), Err(Error::InvalidCacheEntry)));
}
