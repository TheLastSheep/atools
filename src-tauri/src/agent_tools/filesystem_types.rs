use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindLocalFilesOptions {
    pub limit: usize,
    pub max_depth: Option<usize>,
    pub ignore_dirs: Vec<String>,
    pub ignore_patterns: Vec<String>,
}

impl Default for FindLocalFilesOptions {
    fn default() -> Self {
        Self {
            limit: 50,
            max_depth: None,
            ignore_dirs: Vec::new(),
            ignore_patterns: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindLocalFilesReport {
    pub items: Vec<FileMatch>,
    pub skipped_permission_errors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameOperation {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameResult {
    pub from: String,
    pub to: String,
    pub status: String,
    pub dry_run: bool,
    pub from_exists: bool,
    pub to_exists: bool,
    pub parent_exists: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentAiConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub temperature: f64,
}

pub fn find_local_files(root: &Path, query: &str, limit: usize) -> Result<Vec<FileMatch>, String> {
    Ok(find_local_files_with_options(
        root,
        query,
        &FindLocalFilesOptions {
            limit,
            ..FindLocalFilesOptions::default()
        },
    )?
    .items)
}

pub fn find_local_files_with_options(
    root: &Path,
    query: &str,
    options: &FindLocalFilesOptions,
) -> Result<FindLocalFilesReport, String> {
    let mut report = FindLocalFilesReport {
        items: Vec::new(),
        skipped_permission_errors: 0,
    };
    let query_lower = query.to_lowercase();
    visit_files(root, root, &query_lower, options, 0, &mut report)?;
    Ok(report)
}

pub fn plan_renames(
    operations: &[RenameOperation],
    dry_run: bool,
) -> Result<Vec<RenameResult>, String> {
    let mut results = Vec::with_capacity(operations.len());
    let mut targets = std::collections::HashSet::new();

    for operation in operations {
        let from = Path::new(&operation.from);
        let to = Path::new(&operation.to);
        let from_exists = from.exists();
        let to_exists = to.exists();
        let parent_exists = to
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::exists)
            .unwrap_or(true);

        if operation.from == operation.to {
            return Err(format!(
                "Invalid rename from {} to {}: source and target are identical",
                operation.from, operation.to
            ));
        }
        if !from_exists {
            return Err(format!(
                "Invalid rename from {}: source does not exist",
                operation.from
            ));
        }
        if !parent_exists {
            return Err(format!(
                "Invalid rename to {}: parent directory does not exist",
                operation.to
            ));
        }
        if to_exists {
            return Err(format!(
                "Invalid rename to {}: target already exists",
                operation.to
            ));
        }
        if !targets.insert(operation.to.clone()) {
            return Err(format!(
                "Invalid rename to {}: duplicate target in rename plan",
                operation.to
            ));
        }

        results.push(RenameResult {
            from: operation.from.clone(),
            to: operation.to.clone(),
            status: if dry_run { "planned" } else { "validated" }.to_string(),
            dry_run,
            from_exists,
            to_exists,
            parent_exists,
        });
    }

    if dry_run {
        return Ok(results);
    }

    for result in &mut results {
        fs::rename(&result.from, &result.to)
            .map_err(|e| format!("Failed to rename {}: {}", result.from, e))?;
        result.status = "renamed".to_string();
    }
    Ok(results)
}
