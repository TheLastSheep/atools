use std::ffi::CString;
use std::path::{Path, PathBuf};

#[link(name = "sandbox")]
extern "C" {
    fn sandbox_init(
        profile: *const libc::c_char,
        flags: u64,
        errorbuf: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn sandbox_free_error(errorbuf: *mut libc::c_char);
}

pub(super) fn install(cache_root: &Path, stage_root: &Path) -> Result<(), &'static str> {
    let profile = render(cache_root, stage_root)?;
    let profile = CString::new(profile).map_err(|_| "dependency_worker_sandbox_unavailable")?;
    let mut error = std::ptr::null_mut();
    let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error) };
    if !error.is_null() {
        unsafe { sandbox_free_error(error) };
    }
    if result == 0 {
        Ok(())
    } else {
        Err("dependency_worker_sandbox_unavailable")
    }
}

fn render(cache_root: &Path, stage_root: &Path) -> Result<String, &'static str> {
    if !cache_root.is_absolute()
        || !stage_root.is_absolute()
        || cache_root == stage_root
        || stage_root.starts_with(cache_root)
        || cache_root.starts_with(stage_root)
    {
        return Err("dependency_worker_roots_invalid");
    }
    let mut profile = String::from(
        "(version 1)\n(deny default)\n(allow process-info* (target self))\n(allow sysctl-read)\n",
    );
    profile.push_str(&format!(
        "(allow file-read* (subpath {}))\n",
        quote(cache_root)?
    ));
    profile.push_str(&format!(
        "(allow file-read* file-write* (subpath {}))\n",
        quote(stage_root)?
    ));
    let mut ancestors = vec![PathBuf::from("/")];
    for root in [cache_root, stage_root] {
        for ancestor in root.ancestors().skip(1) {
            if !ancestors.iter().any(|known| known == ancestor) {
                ancestors.push(ancestor.to_path_buf());
            }
        }
    }
    profile.push_str("(allow file-read-metadata");
    for ancestor in ancestors {
        profile.push_str(&format!(" (literal {})", quote(&ancestor)?));
    }
    profile.push_str(")\n");
    // Deny default intentionally grants neither process-fork/exec nor network.
    Ok(profile)
}

fn quote(path: &Path) -> Result<String, &'static str> {
    let value = path.to_str().ok_or("dependency_worker_roots_invalid")?;
    if value.chars().any(char::is_control) {
        return Err("dependency_worker_roots_invalid");
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_allows_only_cache_read_and_private_stage_write() {
        let value = render(Path::new("/app/cache"), Path::new("/app/stage/one")).unwrap();
        assert!(value.contains("(allow file-read* (subpath \"/app/cache\"))"));
        assert!(value.contains("(allow file-read* file-write* (subpath \"/app/stage/one\"))"));
        assert_eq!(value.matches("file-write*").count(), 1);
        for forbidden in [
            "allow network",
            "allow process-fork",
            "allow process-exec",
            "(import",
        ] {
            assert!(!value.contains(forbidden));
        }
    }

    #[test]
    fn sandbox_rejects_overlapping_roots_and_quotes_paths() {
        assert!(render(Path::new("/app/root"), Path::new("/app/root/stage")).is_err());
        assert!(render(Path::new("/app/a\nb"), Path::new("/app/stage")).is_err());
        let value = render(Path::new("/app/a\"b"), Path::new("/app/stage")).unwrap();
        assert!(value.contains("/app/a\\\"b"));
    }
}
