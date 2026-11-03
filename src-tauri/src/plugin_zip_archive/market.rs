//! Market-specific entry point; it shares parsing but keeps the larger route's own limits.
use super::{ZipArchiveIndex, ZipLimits};
use std::path::Path;

pub(crate) fn stage_market_archive<'a>(
    bytes: &'a [u8],
    destination: &Path,
    source_url: &str,
) -> Result<ZipArchiveIndex<'a>, String> {
    let mut index = ZipArchiveIndex::open_borrowed(bytes, ZipLimits::MARKET)
        .map_err(|error| format!("Invalid plugin market zip from {source_url}: {error}"))?;
    index.materialize_all(destination)?;
    Ok(index)
}
