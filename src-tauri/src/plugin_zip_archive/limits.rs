//! Route-specific ZIP limits. Shared parsing must not collapse market and local policy.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ZipLimits {
    pub compressed_bytes: usize,
    pub declared_bytes: usize,
    pub projected_bytes: usize,
    pub actual_bytes: usize,
    pub entry_bytes: usize,
    pub entries: usize,
    pub path_depth: usize,
}

impl ZipLimits {
    pub(crate) const LOCAL: Self = Self {
        compressed_bytes: 64 * 1024 * 1024,
        declared_bytes: 128 * 1024 * 1024,
        projected_bytes: 128 * 1024 * 1024,
        actual_bytes: 128 * 1024 * 1024,
        entry_bytes: 32 * 1024 * 1024,
        entries: 4096,
        path_depth: 32,
    };

    pub(crate) const MARKET: Self = Self {
        compressed_bytes: 50 * 1024 * 1024,
        declared_bytes: 64 * 1024 * 1024,
        projected_bytes: 64 * 1024 * 1024,
        actual_bytes: 64 * 1024 * 1024,
        entry_bytes: 32 * 1024 * 1024,
        entries: 4096,
        path_depth: 32,
    };

    #[cfg(test)]
    pub(crate) fn with_expansion_limit(mut self, bytes: usize) -> Self {
        self.declared_bytes = bytes;
        self.projected_bytes = bytes;
        self.actual_bytes = bytes;
        self
    }
}
