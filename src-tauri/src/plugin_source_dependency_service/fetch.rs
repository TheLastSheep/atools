use super::archive_store::{
    ArchiveIdentity, ArchiveStore, CachedArchive, CorruptArchive, ARCHIVE_LIMIT, PLAN_ARCHIVE_LIMIT,
};
use atools_plugin::source_build::{verify_archive_integrity, LockedDependencyPlanV1};
use reqwest::{Client, Url};
use std::{
    fs::File,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const IO_CHUNK: usize = 64 * 1024;

struct TempArchive<'a> {
    store: &'a ArchiveStore,
    name: String,
    identity: ArchiveIdentity,
    file: Option<File>,
    published: bool,
    cleaned: bool,
    cleanup_unconfirmed: Arc<AtomicBool>,
}

impl Drop for TempArchive<'_> {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.published
            && !self.cleaned
            && self
                .store
                .remove_archive_temp_if_identity(&self.name, &self.identity)
                .is_err()
        {
            self.cleanup_unconfirmed.store(true, Ordering::Release);
        }
    }
}

impl TempArchive<'_> {
    fn cleanup(&mut self) -> Result<(), String> {
        drop(self.file.take());
        if !self.published && !self.cleaned {
            self.store
                .remove_archive_temp_if_identity(&self.name, &self.identity)
                .map_err(|_| "SOURCE_DEPENDENCY_CLEANUP_UNCONFIRMED")?;
            self.cleaned = true;
        }
        Ok(())
    }
}

pub(super) struct FetchResult {
    pub cached_archives: usize,
    pub fetched_archives: usize,
    pub archive_bytes: u64,
    pub elapsed_ms: u64,
}

pub(super) async fn fetch_missing(
    store: &ArchiveStore,
    plan: &LockedDependencyPlanV1,
    lease: &super::super::manager::Lease,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
    cleanup_unconfirmed: &Arc<AtomicBool>,
) -> Result<FetchResult, String> {
    let started = Instant::now();
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "SOURCE_DEPENDENCY_NETWORK_UNAVAILABLE")?;
    let initial_cache_bytes = cache_totals_async(store, cancel, deadline).await?;
    if initial_cache_bytes > super::archive_store::GLOBAL_CACHE_LIMIT {
        return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
    }
    let mut cache_bytes = initial_cache_bytes;
    let mut cached = 0usize;
    let mut fetched = 0usize;
    let mut verified_plan_bytes = 0u64;
    for package in &plan.packages {
        if cancel.load(Ordering::Acquire) {
            return Err("SOURCE_DEPENDENCY_CANCELLED".into());
        }
        let corrupt = match validate_cached_async(store, package, cancel, deadline).await? {
            CachedArchive::Verified { bytes } => {
                verified_plan_bytes = verified_plan_bytes
                    .checked_add(bytes)
                    .ok_or("SOURCE_DEPENDENCY_ARCHIVE_LIMIT")?;
                if verified_plan_bytes > PLAN_ARCHIVE_LIMIT {
                    return Err("SOURCE_DEPENDENCY_ARCHIVE_LIMIT".into());
                }
                cached += 1;
                continue;
            }
            CachedArchive::Corrupt(observed) => Some(observed),
            CachedArchive::Missing => None,
        };
        let url = validated_registry_url(&package.resolved_url)?;
        let request = client.get(url).send();
        let request_remaining = remaining(deadline)?;
        let mut response = tokio::select! {
            _ = cancelled(cancel) => return Err("SOURCE_DEPENDENCY_CANCELLED".into()),
            result = tokio::time::timeout(request_remaining, request) =>
                result.map_err(|_| "SOURCE_DEPENDENCY_FETCH_TIMEOUT")?
                    .map_err(|_| "SOURCE_DEPENDENCY_FETCH_FAILED")?,
        };
        if !response.status().is_success() {
            return Err("SOURCE_DEPENDENCY_FETCH_FAILED".into());
        }
        if response
            .content_length()
            .is_some_and(|size| size == 0 || size > ARCHIVE_LIMIT)
        {
            return Err("SOURCE_DEPENDENCY_ARCHIVE_LIMIT".into());
        }
        let (temp_name, file, temp_identity) = store.create_archive_temp()?;
        let mut temporary = TempArchive {
            store,
            name: temp_name,
            identity: temp_identity,
            file: Some(file),
            published: false,
            cleaned: false,
            cleanup_unconfirmed: Arc::clone(cleanup_unconfirmed),
        };
        let result = async {
            let mut archive = Vec::new();
            while let Some(chunk) = tokio::select! {
                _ = cancelled(cancel) => return Err("SOURCE_DEPENDENCY_CANCELLED".into()),
                chunk = tokio::time::timeout(remaining(deadline)?, response.chunk()) =>
                    chunk.map_err(|_| "SOURCE_DEPENDENCY_FETCH_TIMEOUT")?
                        .map_err(|_| "SOURCE_DEPENDENCY_FETCH_FAILED")?,
            } {
                if chunk.is_empty() {
                    continue;
                }
                let next = (archive.len() as u64)
                    .checked_add(chunk.len() as u64)
                    .ok_or("SOURCE_DEPENDENCY_ARCHIVE_LIMIT")?;
                if next > ARCHIVE_LIMIT
                    || verified_plan_bytes
                        .checked_add(next)
                        .ok_or("SOURCE_DEPENDENCY_ARCHIVE_LIMIT")?
                        > PLAN_ARCHIVE_LIMIT
                {
                    return Err("SOURCE_DEPENDENCY_ARCHIVE_LIMIT".into());
                }
                archive.extend_from_slice(&chunk);
            }
            if archive.is_empty() {
                return Err("SOURCE_DEPENDENCY_INTEGRITY_FAILED".into());
            }
            let archive = verify_archive_async(package.clone(), archive, cancel, deadline).await?;
            let size = archive.len() as u64;
            // A verified replacement may credit only the exact corrupt inode
            // captured above. The temporary archive itself remains capped at 32MiB.
            let persistent_base = cache_bytes
                .checked_sub(corrupt.as_ref().map_or(0, CorruptArchive::bytes))
                .ok_or("SOURCE_DEPENDENCY_CACHE_CHANGED")?;
            let accounted = persistent_base
                .checked_add(size)
                .ok_or("SOURCE_DEPENDENCY_CACHE_LIMIT")?;
            if accounted > super::archive_store::GLOBAL_CACHE_LIMIT {
                return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
            }
            let file = temporary
                .file
                .take()
                .ok_or("SOURCE_DEPENDENCY_CACHE_WRITE")?;
            let written = write_archive_async(file, archive, cancel, deadline).await?;
            if written != size {
                return Err("SOURCE_DEPENDENCY_CACHE_WRITE".into());
            }
            lease.phase(super::super::manager::Phase::Publishing)?;
            publish_archive_async(
                store,
                &temporary.name,
                package,
                corrupt.as_ref(),
                cancel,
                deadline,
            )
            .await?;
            temporary.published = true;
            lease.phase(super::super::manager::Phase::Fetching)?;
            Ok((size, accounted))
        }
        .await;
        match result {
            Ok((size, accounted)) => {
                fetched += 1;
                verified_plan_bytes += size;
                cache_bytes = accounted;
            }
            Err(error) => {
                if error == "SOURCE_DEPENDENCY_CACHE_CLEANUP_UNCONFIRMED" {
                    cleanup_unconfirmed.store(true, Ordering::Release);
                }
                if temporary.cleanup().is_err() {
                    return Err("SOURCE_DEPENDENCY_CLEANUP_UNCONFIRMED".into());
                }
                return Err(error);
            }
        }
    }
    if cache_totals_async(store, cancel, deadline).await? > super::archive_store::GLOBAL_CACHE_LIMIT
    {
        return Err("SOURCE_DEPENDENCY_CACHE_LIMIT".into());
    }
    Ok(FetchResult {
        cached_archives: cached,
        fetched_archives: fetched,
        archive_bytes: verified_plan_bytes,
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

fn validated_registry_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "SOURCE_DEPENDENCY_REGISTRY_URL_INVALID")?;
    if url.scheme() != "https"
        || url.host_str() != Some("registry.npmjs.org")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with(".tgz")
        || url.path().contains("%2f")
        || url.path().contains("%2F")
    {
        return Err("SOURCE_DEPENDENCY_REGISTRY_URL_INVALID".into());
    }
    Ok(url)
}

async fn validate_cached_async(
    store: &ArchiveStore,
    package: &atools_plugin::source_build::LockedPackageV1,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<CachedArchive, String> {
    let store = store.duplicate_for_inventory()?;
    let package = package.clone();
    let cancel_for_worker = Arc::clone(cancel);
    run_blocking_bounded(
        cancel,
        deadline,
        move || {
            if cancel_for_worker.load(Ordering::Acquire) {
                return Err("SOURCE_DEPENDENCY_CANCELLED".into());
            }
            store.inspect_archive(&package)
        },
        "SOURCE_DEPENDENCY_CACHE_READ",
    )
    .await
}

async fn cache_totals_async(
    store: &ArchiveStore,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<u64, String> {
    let store = store.duplicate_for_inventory()?;
    let cancel_for_worker = Arc::clone(cancel);
    run_blocking_bounded(
        cancel,
        deadline,
        move || store.cache_totals(&cancel_for_worker),
        "SOURCE_DEPENDENCY_CACHE_SCAN_FAILED",
    )
    .await
}

async fn verify_archive_async(
    package: atools_plugin::source_build::LockedPackageV1,
    archive: Vec<u8>,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let cancel_for_worker = Arc::clone(cancel);
    run_blocking_bounded(
        cancel,
        deadline,
        move || {
            if cancel_for_worker.load(Ordering::Acquire) {
                return Err("SOURCE_DEPENDENCY_CANCELLED".into());
            }
            if Instant::now() >= deadline {
                return Err("SOURCE_DEPENDENCY_FETCH_TIMEOUT".into());
            }
            if !verify_archive_integrity(&package, &archive) {
                return Err("SOURCE_DEPENDENCY_INTEGRITY_FAILED".into());
            }
            if cancel_for_worker.load(Ordering::Acquire) {
                return Err("SOURCE_DEPENDENCY_CANCELLED".into());
            }
            Ok(archive)
        },
        "SOURCE_DEPENDENCY_INTEGRITY_FAILED",
    )
    .await
}

async fn publish_archive_async(
    store: &ArchiveStore,
    temporary: &str,
    package: &atools_plugin::source_build::LockedPackageV1,
    corrupt: Option<&CorruptArchive>,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<(), String> {
    let store = store.duplicate_for_inventory()?;
    let temporary = temporary.to_owned();
    let package = package.clone();
    let corrupt = corrupt.cloned();
    let cancel_for_worker = Arc::clone(cancel);
    run_blocking_bounded(
        cancel,
        deadline,
        move || {
            if cancel_for_worker.load(Ordering::Acquire) {
                return Err("SOURCE_DEPENDENCY_CANCELLED".into());
            }
            if Instant::now() >= deadline {
                return Err("SOURCE_DEPENDENCY_FETCH_TIMEOUT".into());
            }
            if let Some(observed) = corrupt.as_ref() {
                store.publish_repaired_archive(&temporary, &package, observed)?;
            } else {
                store.publish_archive(&temporary, &package.archive_id_sha256)?;
            }
            Ok(())
        },
        "SOURCE_DEPENDENCY_CACHE_PUBLISH",
    )
    .await
}

async fn write_archive_async(
    mut file: File,
    bytes: Vec<u8>,
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<u64, String> {
    let cancel_for_worker = Arc::clone(cancel);
    run_blocking_bounded(
        cancel,
        deadline,
        move || {
            let mut written = 0usize;
            for chunk in bytes.chunks(IO_CHUNK) {
                if cancel_for_worker.load(Ordering::Acquire) {
                    return Err("SOURCE_DEPENDENCY_CANCELLED".into());
                }
                if Instant::now() >= deadline {
                    return Err("SOURCE_DEPENDENCY_FETCH_TIMEOUT".into());
                }
                file.write_all(chunk)
                    .map_err(|_| "SOURCE_DEPENDENCY_CACHE_WRITE")?;
                written = written
                    .checked_add(chunk.len())
                    .ok_or("SOURCE_DEPENDENCY_ARCHIVE_LIMIT")?;
            }
            file.sync_all()
                .map_err(|_| "SOURCE_DEPENDENCY_CACHE_SYNC")?;
            Ok(written as u64)
        },
        "SOURCE_DEPENDENCY_CACHE_WRITE",
    )
    .await
}

async fn run_blocking_bounded<T, F>(
    cancel: &Arc<AtomicBool>,
    deadline: Instant,
    task: F,
    join_error: &'static str,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    if cancel.load(Ordering::Acquire) {
        return Err("SOURCE_DEPENDENCY_CANCELLED".into());
    }
    let wait = remaining(deadline)?;
    let mut handle = tokio::task::spawn_blocking(task);
    tokio::select! {
        joined = tokio::time::timeout(wait, &mut handle) => match joined {
            Ok(joined) => joined.map_err(|_| join_error.to_owned())?,
            Err(_) => {
                cancel.store(true, Ordering::Release);
                let _ = handle.await;
                Err("SOURCE_DEPENDENCY_FETCH_TIMEOUT".into())
            }
        },
        _ = cancelled(cancel.as_ref()) => {
            let _ = handle.await.map_err(|_| join_error.to_owned())?;
            Err("SOURCE_DEPENDENCY_CANCELLED".into())
        }
    }
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("SOURCE_DEPENDENCY_FETCH_TIMEOUT".into())
    } else {
        Ok(remaining)
    }
}

async fn cancelled(cancel: &AtomicBool) {
    loop {
        if cancel.load(Ordering::Acquire) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
