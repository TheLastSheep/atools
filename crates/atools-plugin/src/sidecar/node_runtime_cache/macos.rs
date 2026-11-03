use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use uuid::Uuid;

use super::gzip;
use super::lock;
use super::metadata::{self, MAX_COMPRESSED_BYTES, MAX_LICENSE_BYTES, MAX_METADATA_BYTES, MAX_SIGNED_BINARY_BYTES, METADATA_NAME, LICENSE_NAME};
use super::unix::{self, Directory, Identity};
use super::{CachedNode, NodeRuntimeCacheError as Error, NodeTarget, RuntimeSignaturePolicy, RuntimeSignatureVerifier};

const NODE_FILE_PREFIX: &str = "node-";
const PIN_BYTES: &[u8] = include_bytes!("../../../../../resources/node-runtime/pin.json");

pub(super) fn ensure(
    resource_directory: &Path,
    target: NodeTarget,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<CachedNode, Error> {
    let cache_base = dirs::cache_dir().ok_or(Error::InvalidCacheEntry)?;
    ensure_impl(resource_directory, &cache_base, PIN_BYTES, target, policy, verifier, cancelled)
}

#[cfg(test)]
pub(super) fn ensure_at_with_pin(
    resource_directory: &Path,
    cache_base: &Path,
    pin_bytes: &[u8],
    target: NodeTarget,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<CachedNode, Error> {
    ensure_impl(resource_directory, cache_base, pin_bytes, target, policy, verifier, cancelled)
}

fn ensure_impl(
    resource_directory: &Path,
    cache_base: &Path,
    pin_bytes: &[u8],
    target: NodeTarget,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<CachedNode, Error> {
    unix::check_cancel(cancelled)?;
    let resources = Directory::open_absolute(resource_directory)?;
    validate_resource_names(&resources, target)?;
    let (metadata_bytes, _) = resources.read_regular(METADATA_NAME, MAX_METADATA_BYTES as u64, cancelled)?;
    let payload = metadata::validate(&metadata_bytes, pin_bytes, target, policy)?;
    let (license, _) = resources.read_regular(LICENSE_NAME, MAX_LICENSE_BYTES, cancelled)?;
    if metadata::sha256(&license) != payload.license_sha256 { return Err(Error::InvalidPayload); }

    let cache = unix::private_cache_root(cache_base)?;
    if cache.path().components().count() < 2 || cache.path().file_name().is_none() {
        return Err(Error::InvalidCacheEntry);
    }
    let _lock = lock::acquire(&cache, cancelled)?;
    unix::check_cancel(cancelled)?;
    let cache_name = cache_name(&payload);
    if let Some(node) = try_cached(&cache, &cache_name, &payload, policy, verifier, cancelled)? {
        return Ok(node);
    }
    build_cache_entry(&resources, &cache, &cache_name, &payload, policy, verifier, cancelled)
}

fn validate_resource_names(resources: &Directory, target: NodeTarget) -> Result<(), Error> {
    let mut actual = resources.list_names()?.into_iter().map(|name| name.into_string().map_err(|_| Error::InvalidPayload))
        .collect::<Result<Vec<_>, _>>()?;
    actual.sort();
    let mut expected = vec![METADATA_NAME.to_string(), LICENSE_NAME.to_string(), format!("node-{}.gz", target.as_str())];
    expected.sort();
    if actual != expected { return Err(Error::InvalidPayload); }
    Ok(())
}

fn cache_name(payload: &metadata::ValidatedPayload) -> String {
    let identity = format!("schema2\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        payload.target.as_str(), payload.version, payload.pin_sha256, payload.metadata_sha256,
        payload.compressed_sha256, payload.signed_sha256, payload.entitlements_sha256);
    format!("{NODE_FILE_PREFIX}{}-{}.bin", payload.target.as_str(), metadata::sha256(identity.as_bytes()))
}

fn try_cached(
    cache: &Directory,
    name: &str,
    payload: &metadata::ValidatedPayload,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<Option<CachedNode>, Error> {
    unix::check_cancel(cancelled)?;
    let owner = unsafe { libc::geteuid() };
    let opened = match cache.open_regular(name, Some(owner), Some(0o500)) {
        Ok(opened) => opened,
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::InvalidCacheEntry),
    };
    if opened.identity.size_bytes() != payload.signed_bytes { return Err(Error::InvalidCacheEntry); }
    let mut file = opened.file;
    let identity = opened.identity;
    let hash = unix::hash_file(&mut file, &identity, MAX_SIGNED_BINARY_BYTES, cancelled)?;
    if hash != payload.signed_sha256 { return Err(Error::InvalidCacheEntry); }
    verify_signature(cache, name, &mut file, &identity, payload, policy, verifier, cancelled)?;
    unix::check_cancel(cancelled)?;
    cache.verify_named_identity(name, &identity)?;
    Ok(Some(CachedNode { path: cache.path().join(name), target: payload.target, sha256: hash, bytes: payload.signed_bytes }))
}

fn build_cache_entry(
    resources: &Directory,
    cache: &Directory,
    cache_name: &str,
    payload: &metadata::ValidatedPayload,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<CachedNode, Error> {
    let compressed = resources.open_regular(&payload.compressed_name, None, None)?;
    if compressed.identity.size_bytes() != payload.compressed_bytes || compressed.identity.size_bytes() > MAX_COMPRESSED_BYTES {
        return Err(Error::InvalidPayload);
    }
    let temp_name = format!(".node-cache-{}.tmp", Uuid::new_v4());
    let temp = cache.create_private_file(&temp_name)?;
    let temp_identity = temp.identity;
    let mut output = Some(temp.file);
    let result = (|| {
        let mut compressed_file = compressed.file;
        let output_file = output.as_mut().ok_or(Error::InvalidCacheEntry)?;
        let unpacked = gzip::unpack(
            &mut compressed_file,
            &mut *output_file,
            MAX_SIGNED_BINARY_BYTES,
            payload.signed_bytes,
            &payload.signed_sha256,
            MAX_COMPRESSED_BYTES,
            payload.compressed_bytes,
            &payload.compressed_sha256,
            || cancelled.load(std::sync::atomic::Ordering::Acquire),
        )?;
        if unpacked.bytes != payload.signed_bytes || unpacked.compressed_bytes != payload.compressed_bytes
            || unpacked.sha256 != payload.signed_sha256 || unpacked.compressed_sha256 != payload.compressed_sha256 {
            return Err(Error::InvalidPayload);
        }
        let compressed_after = unix::Identity::from(&compressed_file.metadata()?);
        if !unix::same_contents(&compressed.identity, &compressed_after) {
            return Err(Error::InvalidPayload);
        }
        resources.verify_named_identity(&payload.compressed_name, &compressed.identity)?;
        output_file.sync_all()?;
        Directory::chmod_file(output_file, 0o500)?;
        output_file.sync_all()?;
        unix::check_cancel(cancelled)?;
        let temp_after = cache.identity(output_file)?;
        if !temp_identity.same_inode(&temp_after) { return Err(Error::InvalidCacheEntry); }
        cache.verify_named_identity(&temp_name, &temp_after)?;
        drop(output.take());

        let signed = cache.open_regular(&temp_name, Some(unsafe { libc::geteuid() }), Some(0o500))?;
        if signed.identity.size_bytes() != payload.signed_bytes { return Err(Error::InvalidCacheEntry); }
        let mut signed_file = signed.file;
        let signed_hash = unix::hash_file(&mut signed_file, &signed.identity, MAX_SIGNED_BINARY_BYTES, cancelled)?;
        if signed_hash != payload.signed_sha256 { return Err(Error::InvalidPayload); }
        verify_signature(cache, &temp_name, &mut signed_file, &signed.identity, payload, policy, verifier, cancelled)?;
        cache.verify_named_identity(&temp_name, &signed.identity)?;
        unix::check_cancel(cancelled)?;
        match cache.rename_noreplace(&temp_name, cache_name) {
            Ok(()) => {},
            Err(Error::Io(error)) if error.raw_os_error() == Some(libc::EEXIST) => {
                let _ = cache.remove_owned(&temp_name, &temp_identity)?;
                return try_cached(cache, cache_name, payload, policy, verifier, cancelled)?.ok_or(Error::InvalidCacheEntry);
            }
            Err(error) => return Err(error),
        }
        cache.verify_named_identity(cache_name, &signed.identity)?;
        Ok(CachedNode { path: cache.path().join(cache_name), target: payload.target, sha256: payload.signed_sha256.clone(), bytes: payload.signed_bytes })
    })();
    drop(output);
    if result.is_err() { let _ = cache.remove_owned(&temp_name, &temp_identity); }
    result
}

fn verify_signature(
    cache: &Directory,
    name: &str,
    opened: &mut File,
    identity: &Identity,
    payload: &metadata::ValidatedPayload,
    policy: &RuntimeSignaturePolicy,
    verifier: &dyn RuntimeSignatureVerifier,
    cancelled: &AtomicBool,
) -> Result<(), Error> {
    unix::check_cancel(cancelled)?;
    let before = cache.identity(opened)?;
    if !unix::same_contents(identity, &before) { return Err(Error::InvalidCacheEntry); }
    opened.seek(SeekFrom::Start(0))?;
    let path = cache.path().join(name);
    if verifier.verify_signed_binary(&path, opened, payload.target, &policy.expected_team_id, &payload.entitlements_sha256, cancelled).is_err() {
        return if cancelled.load(std::sync::atomic::Ordering::Acquire) { Err(Error::Cancelled) } else { Err(Error::SignatureRejected) };
    }
    unix::check_cancel(cancelled)?;
    let after = cache.identity(opened)?;
    if !unix::same_contents(&before, &after) { return Err(Error::InvalidCacheEntry); }
    cache.verify_named_identity(name, identity)?;
    Ok(())
}
