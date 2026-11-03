//! One coherent SQLite snapshot, reused until local metadata or another connection changes.
use crate::feature_catalog::{
    budget_error, validate_admitted_index_budget, validate_index_budget, CatalogFeature,
    FeatureCatalogSnapshot, MAX_FEATURE_CATALOG_COMMANDS, MAX_FEATURE_CATALOG_FEATURES,
    MAX_FEATURE_CATALOG_METADATA_BYTES,
};
use crate::plugin_presentation::readable_feature_label;
use crate::{Database, FeatureEntry, Result};
use rusqlite::Connection;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(super) struct FeatureCatalogCache {
    revision: u64,
    key: Option<(u64, i64)>,
    snapshot: Option<Arc<FeatureCatalogSnapshot>>,
    // At most one fully admitted bank; old snapshots share its explicit cache.
    text_regex: Option<crate::matcher::TypedTextRegexBank>,
}

impl FeatureCatalogCache {
    pub(super) fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.key = None;
        self.snapshot = None;
    }
    pub(super) fn publish_mutation(&mut self, bank: Option<crate::matcher::TypedTextRegexBank>) {
        self.invalidate();
        if let Some(bank) = bank {
            self.text_regex = Some(bank);
        }
    }
}

impl Database {
    /// Warm calls only query SQLite's connection-local data version and clone an Arc.
    /// No manifest files, plugin scripts, directory scans, or query-result caches.
    pub fn feature_catalog_snapshot(&self) -> Result<Arc<FeatureCatalogSnapshot>> {
        // All paths acquire connection before cache, including successful mutators.
        let mut conn = self.conn.lock();
        let version = data_version(&conn)?;
        let mut cache = self.feature_catalog.lock();
        let key = (cache.revision, version);
        if cache.key == Some(key) {
            if let Some(snapshot) = &cache.snapshot {
                return Ok(snapshot.clone());
            }
        }
        let tx = conn.transaction()?;
        let entries = read_entries(&tx)?;
        validate_index_budget(&entries.0)?;
        let text_regex = admit_text_regex(&entries.0, cache.text_regex.as_ref())?;
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let snapshot = Arc::new(FeatureCatalogSnapshot::build(
            generation,
            entries.0,
            entries.1,
            text_regex.clone(),
        )?);
        tx.commit()?;
        // Another connection may commit while this WAL read transaction is active.
        // Return the coherent read, but never publish it under a superseded version.
        if data_version(&conn)? == version {
            cache.text_regex = Some(text_regex);
            cache.key = Some(key);
            cache.snapshot = Some(snapshot.clone());
        }
        Ok(snapshot)
    }
}

/// Validate the prospective write transaction before publishing effective catalog rows.
/// Reuse metadata/count/allowance and typed program/cache admission from snapshot reads.
pub(super) fn validate_mutation(
    conn: &Connection,
    cache: &FeatureCatalogCache,
) -> Result<crate::matcher::TypedTextRegexBank> {
    let (entries, _) = read_entries(conn)?;
    validate_index_budget(&entries)?;
    let bank = admit_text_regex(&entries, cache.text_regex.as_ref())?;
    validate_admitted_index_budget(&entries, &bank)?;
    Ok(bank)
}

fn admit_text_regex(
    entries: &[CatalogFeature],
    previous: Option<&crate::matcher::TypedTextRegexBank>,
) -> Result<crate::matcher::TypedTextRegexBank> {
    crate::matcher::TypedTextRegexBank::build_reusing_commands(
        entries.iter().flat_map(|entry| &entry.feature.cmds),
        previous,
    )
}

fn data_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA data_version", [], |row| row.get(0))?)
}

struct PluginMetadata {
    id: String,
    name: String,
    path: String,
    title: Option<String>,
    logo: Option<String>,
    declared_labels: std::collections::HashMap<String, String>,
}

#[derive(serde::Deserialize)]
struct PresentationManifest {
    title: Option<String>,
    logo: Option<String>,
    #[serde(default, deserialize_with = "bounded_declarations")]
    features: Vec<DeclaredLabel>,
}

#[derive(serde::Deserialize)]
struct DeclaredLabel {
    code: String,
    label: Option<String>,
}

fn bounded_declarations<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<DeclaredLabel>, D::Error> {
    struct Declarations;
    impl<'de> serde::de::Visitor<'de> for Declarations {
        type Value = Vec<DeclaredLabel>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("at most 20000 feature declarations")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut declarations = Vec::new();
            while let Some(item) = sequence.next_element()? {
                if declarations.len() >= MAX_FEATURE_CATALOG_FEATURES {
                    return Err(serde::de::Error::custom(
                        "Feature catalog budget exceeded: more than 20000 declarations",
                    ));
                }
                declarations.push(item);
            }
            Ok(declarations)
        }
    }
    deserializer.deserialize_seq(Declarations)
}

fn read_entries(conn: &Connection) -> Result<(Vec<CatalogFeature>, usize)> {
    // Direct-column octet_length reads SQLite's stored size before materializing
    // any Rust String/Vec, and this transaction makes both checks and rows agree.
    let mut bytes = preflight(conn)?;
    let mut plugins = std::collections::HashMap::new();
    let mut stmt = conn.prepare_cached(
        "SELECT id, name, path, config FROM plugins WHERE enabled = 1
         AND EXISTS (SELECT 1 FROM features WHERE plugin_id = plugins.id)",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let manifest: PresentationManifest = serde_json::from_str(&row.get::<_, String>(3)?)?;
        let declared_labels = manifest
            .features
            .into_iter()
            .filter_map(|feature| {
                feature
                    .label
                    .filter(|label| !label.trim().is_empty())
                    .map(|label| (feature.code, label))
            })
            .collect::<std::collections::HashMap<_, _>>();
        for (code, label) in &declared_labels {
            charge(&mut bytes, code.len() + label.len() + 64)?;
        }
        let metadata = PluginMetadata {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            title: manifest.title,
            logo: manifest.logo,
            declared_labels,
        };
        charge(
            &mut bytes,
            metadata.id.len() + metadata.name.len() + metadata.path.len() + 256,
        )?;
        plugins.insert(metadata.id.clone(), metadata);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT f.code,f.plugin_id,p.name,f.label,f.icon,f.explain,f.cmds,f.main_push,f.priority,
                f.label_declared
         FROM features f JOIN plugins p ON f.plugin_id=p.id WHERE p.enabled=1
         ORDER BY f.priority DESC,f.code ASC",
    )?;
    let mut rows = stmt.query([])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        if result.len() >= MAX_FEATURE_CATALOG_FEATURES {
            return Err(budget_error("more than 20000 features"));
        }
        let raw = FeatureEntry {
            code: row.get(0)?,
            plugin_id: row.get(1)?,
            plugin_name: row.get(2)?,
            label: row.get(3)?,
            icon: row.get(4)?,
            explain: row.get(5)?,
            // Preserve Database::all_features semantics for legacy malformed command JSON.
            cmds: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or_default(),
            main_push: row.get(7)?,
            priority: row.get(8)?,
        };
        let plugin = plugins.get(&raw.plugin_id).ok_or_else(|| {
            crate::AToolsError::Plugin("Feature catalog plugin metadata is inconsistent".into())
        })?;
        let declared: Option<bool> = row.get(9)?;
        let legacy_declared = || {
            (raw.label != raw.code && !raw.label.trim().is_empty())
                .then_some(raw.label.as_str())
                .or_else(|| plugin.declared_labels.get(&raw.code).map(String::as_str))
        };
        let label = readable_feature_label(
            match declared {
                Some(true) => Some(raw.label.as_str()),
                Some(false) => None,
                None => legacy_declared(),
            },
            &raw.explain,
            &raw.cmds,
        );
        let name = plugin
            .title
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&plugin.name);
        let item = CatalogFeature {
            display_label: label.map_or(name, |(label, _)| label).to_string(),
            label_source: label.map_or("plugin_name", |(_, source)| source),
            plugin_display_name: name.to_string(),
            plugin_path: plugin.path.clone(),
            icon: raw
                .icon
                .as_deref()
                .filter(|icon| !icon.trim().is_empty())
                .or(plugin.logo.as_deref())
                .map(|icon| icon.trim().to_string()),
            feature: raw,
        };
        charge(
            &mut bytes,
            item.feature.code.len()
                + item.feature.plugin_id.len()
                + item.feature.plugin_name.len()
                + item.feature.label.len()
                + item.feature.explain.len()
                + item.display_label.len()
                + item.plugin_display_name.len()
                + item.plugin_path.len()
                + item.icon.as_ref().map_or(0, String::len)
                + 512,
        )?;
        result.push(item);
    }
    Ok((result, bytes))
}

fn preflight(conn: &Connection) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM features f JOIN plugins p ON f.plugin_id=p.id WHERE p.enabled=1",
        [],
        |row| row.get(0),
    )?;
    if count > MAX_FEATURE_CATALOG_FEATURES as i64 {
        return Err(budget_error("more than 20000 features"));
    }
    let plugin_bytes: i64 = conn.query_row("SELECT coalesce(sum(octet_length(id)+octet_length(name)+octet_length(path)+octet_length(config)),0)
        FROM plugins WHERE enabled=1 AND EXISTS(SELECT 1 FROM features WHERE plugin_id=plugins.id)", [], |row| row.get(0))?;
    let feature_bytes: i64 = conn.query_row("SELECT coalesce(sum(octet_length(f.code)+octet_length(f.plugin_id)+octet_length(p.name)+octet_length(f.label)
        +coalesce(octet_length(f.icon),0)+octet_length(f.explain)+octet_length(f.cmds)),0)
        FROM features f JOIN plugins p ON f.plugin_id=p.id WHERE p.enabled=1", [], |row| row.get(0))?;
    let mut bytes = 0;
    charge(
        &mut bytes,
        usize::try_from(plugin_bytes).unwrap_or(usize::MAX),
    )?;
    charge(
        &mut bytes,
        usize::try_from(feature_bytes).unwrap_or(usize::MAX),
    )?;
    let commands: i64 = conn.query_row("SELECT coalesce(sum(CASE WHEN json_valid(f.cmds) THEN json_array_length(f.cmds) ELSE 0 END),0)
        FROM features f JOIN plugins p ON f.plugin_id=p.id WHERE p.enabled=1", [], |row| row.get(0))?;
    if commands > MAX_FEATURE_CATALOG_COMMANDS as i64 {
        return Err(budget_error("more than 65536 command rules"));
    }
    Ok(bytes)
}

fn charge(bytes: &mut usize, added: usize) -> Result<()> {
    *bytes = bytes
        .checked_add(added)
        .ok_or_else(|| budget_error("metadata size overflow"))?;
    if *bytes > MAX_FEATURE_CATALOG_METADATA_BYTES {
        return Err(budget_error("metadata exceeds 16 MiB"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "feature_catalog_reuse_tests.rs"]
mod reuse_tests;
