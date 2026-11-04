use super::{
    directory::{self, Directory},
    hash_entry, input_excluded, read_file, TreeStats, DEPTH_LIMIT, ENTRY_LIMIT, FILE_LIMIT,
    TREE_LIMIT,
};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg_attr(not(test), allow(dead_code))]
pub(super) enum Event<'a> {
    RootOpened,
    BeforeDirectoryOpen(&'a Path),
    AfterDirectoryOpen(&'a Path),
}

pub(super) fn tree(
    root: &Path,
    destination: Option<&Path>,
    input: bool,
    cancel: &AtomicBool,
    mut hook: impl FnMut(Event<'_>),
) -> Result<(String, TreeStats), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("SOURCE_BUILD_CANCELLED".into());
    }
    let directory = Directory::absolute(root)?;
    hook(Event::RootOpened);
    let mut context = Context {
        input,
        cancel,
        stats: TreeStats::default(),
        inspected: 0,
        digest: Sha256::new(),
        hook: &mut hook,
    };
    context.visit(&directory, Path::new(""), destination, 0)?;
    Ok((format!("{:x}", context.digest.finalize()), context.stats))
}

struct Context<'a, F> {
    input: bool,
    cancel: &'a AtomicBool,
    stats: TreeStats,
    inspected: usize,
    digest: Sha256,
    hook: &'a mut F,
}
impl<F: FnMut(Event<'_>)> Context<'_, F> {
    fn visit(
        &mut self,
        directory: &Directory,
        relative: &Path,
        destination: Option<&Path>,
        depth: usize,
    ) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("SOURCE_BUILD_CANCELLED".into());
        }
        if depth > DEPTH_LIMIT {
            return Err("SourceBuildTreeDepthExceeded".into());
        }
        let names = directory.names(ENTRY_LIMIT.saturating_sub(self.inspected))?;
        self.inspected += names.len();
        for name in names {
            if self.cancel.load(Ordering::Acquire) {
                return Err("SOURCE_BUILD_CANCELLED".into());
            }
            if self.input && input_excluded(&name) {
                continue;
            }
            self.stats.entries += 1;
            let meta = directory.child_metadata(&name)?;
            let path = relative.join(&name);
            let output = destination.map(|parent| parent.join(&name));
            match directory::kind(&meta) {
                libc::S_IFDIR => {
                    (self.hook)(Event::BeforeDirectoryOpen(&path));
                    let child = directory.open_directory(&name, Some(&meta))?;
                    (self.hook)(Event::AfterDirectoryOpen(&path));
                    hash_entry(&mut self.digest, b'd', &path, &[]);
                    if let Some(output) = &output {
                        fs::create_dir(output).map_err(|_| "SourceBuildSnapshotCreateFailed")?;
                    }
                    self.visit(&child, &path, output.as_deref(), depth + 1)?;
                }
                libc::S_IFREG => {
                    if meta.st_nlink != 1 {
                        return Err("SourceBuildHardlinkRejected".into());
                    }
                    if path.extension().is_some_and(|ext| {
                        ext.eq_ignore_ascii_case("node") || ext.eq_ignore_ascii_case("native")
                    }) {
                        return Err("SourceBuildNativeAddonRejected".into());
                    }
                    let bytes = read_file(directory.open_file(&name, Some(&meta))?, FILE_LIMIT)?;
                    self.stats.bytes = self
                        .stats
                        .bytes
                        .checked_add(bytes.len() as u64)
                        .ok_or("SourceBuildTreeBytesExceeded")?;
                    if self.stats.bytes > TREE_LIMIT {
                        return Err("SourceBuildTreeBytesExceeded".into());
                    }
                    hash_entry(&mut self.digest, b'f', &path, &bytes);
                    if let Some(output) = output {
                        OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(output)
                            .and_then(|mut file| file.write_all(&bytes))
                            .map_err(|_| "SourceBuildSnapshotWriteFailed")?;
                    }
                }
                libc::S_IFLNK => return Err("SourceBuildSymlinkRejected".into()),
                _ => return Err("SourceBuildSpecialFileRejected".into()),
            }
        }
        Ok(())
    }
}
