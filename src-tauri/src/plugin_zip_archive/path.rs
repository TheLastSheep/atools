use super::ZipLimits;

pub(crate) fn archive_path(value: &str, limits: ZipLimits) -> Result<String, String> {
    if value.is_empty() || value.contains(['\\', '\0', ':']) || value.starts_with('/') {
        return Err("Unsafe plugin archive path".into());
    }
    let mut parts = Vec::new();
    for part in value.trim_end_matches('/').split('/') {
        match part {
            "" | "." => {}
            ".." => return Err("Plugin archive path escapes package".into()),
            segment => parts.push(segment),
        }
    }
    if parts.is_empty() || parts.len() > limits.path_depth {
        return Err("Plugin archive path is empty or exceeds depth budget".into());
    }
    Ok(parts.join("/"))
}

pub(crate) fn resolve_alias_target(alias: &str, target: &str) -> Result<String, String> {
    if target.is_empty()
        || target.len() > 4096
        || !target.is_char_boundary(target.len())
        || target.contains(['\\', '\0', ':'])
        || target.starts_with('/')
    {
        return Err("ZIP CLI alias target is unsafe".into());
    }
    let parent = alias
        .rsplit_once('/')
        .ok_or("ZIP CLI alias has no parent")?
        .0;
    let mut parts: Vec<&str> = parent.split('/').collect();
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." if !parts.is_empty() => {
                parts.pop();
            }
            ".." => return Err("ZIP CLI alias escapes archive root".into()),
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        return Err("ZIP CLI alias target is empty".into());
    }
    Ok(parts.join("/"))
}

pub(crate) fn is_cli_alias(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    parts.len() >= 3
        && parts[parts.len() - 3] == "node_modules"
        && parts[parts.len() - 2] == ".bin"
        && !parts[parts.len() - 1].is_empty()
}

pub(crate) fn in_scope(path: &str, prefix: &str) -> bool {
    prefix.is_empty()
        || path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}
