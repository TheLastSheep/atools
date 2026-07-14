//! SQLite-backed database layer for ATools.
//!
//! Provides the [`Database`] struct that manages plugin metadata, feature indexing,
//! per-plugin document storage (PouchDB-compatible), binary attachments, and app settings.

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde_json::{self, Value};

use crate::agent::{
    AgentToolGrant, AuditLogEntry, AuditLogPage, AuditLogQuery, AuditStatus, PermissionScope,
    ToolDefinition,
};
use crate::error::{AToolsError, Result};
use crate::memory::{validate_memory_content, MemoryApproval, MemoryItem, MemoryScope, MemoryType};
use crate::models::{
    ClipboardHistoryEntry, Document, Feature, FeatureEntry, Plugin, PluginManifest,
};
use crate::skill::SkillDefinition;
use crate::task_run::{
    Artifact, ResultAction, TaskIssue, TaskRun, TaskRunInitiator, TaskRunInitiatorType,
    TaskRunStatus, TaskValidation,
};
use crate::utils::generate_rev;

/// Central database handle wrapping a SQLite connection.
///
/// Thread-safe via `Arc<Mutex<Connection>>` using `parking_lot::Mutex` for
/// better performance than `std::sync::Mutex` in low-contention scenarios.
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Opens or creates a SQLite database at the given path.
    ///
    /// Automatically runs schema migrations on open.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be opened or migrations fail.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Opens or creates the default database at `~/.atools/data.db`.
    ///
    /// Ensures the base directory exists, then opens the database with migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the home directory cannot be determined, the directory
    /// cannot be created, or migrations fail.
    pub fn new() -> Result<Self> {
        let config = crate::config::AppConfig::new()?;
        config.ensure_dirs()?;
        Self::open(&config.db_path())
    }

    /// Creates an in-memory database (useful for testing).
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Runs schema migrations to ensure the database structure is up-to-date.
    fn run_migrations(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS plugins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                path TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                config TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS features (
                code TEXT PRIMARY KEY,
                plugin_id TEXT NOT NULL,
                label TEXT NOT NULL,
                icon TEXT,
                explain TEXT NOT NULL,
                cmds TEXT NOT NULL DEFAULT '[]',
                main_push BOOLEAN NOT NULL DEFAULT 0,
                priority INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS plugin_data (
                plugin_id TEXT NOT NULL,
                _id TEXT NOT NULL,
                data TEXT NOT NULL DEFAULT '{}',
                rev TEXT NOT NULL,
                PRIMARY KEY (plugin_id, _id),
                FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS plugin_data_attachments (
                plugin_id TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                name TEXT NOT NULL,
                data BLOB NOT NULL,
                content_type TEXT NOT NULL,
                PRIMARY KEY (plugin_id, doc_id, name),
                FOREIGN KEY (plugin_id, doc_id) REFERENCES plugin_data(plugin_id, _id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                client_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                input TEXT NOT NULL,
                output TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                error TEXT
            );

            CREATE TABLE IF NOT EXISTS task_runs (
                id TEXT PRIMARY KEY,
                capability_id TEXT NOT NULL,
                initiator_type TEXT NOT NULL,
                client_id TEXT,
                status TEXT NOT NULL,
                input TEXT NOT NULL,
                output TEXT NOT NULL,
                summary TEXT,
                progress INTEGER,
                artifacts TEXT NOT NULL DEFAULT '[]',
                warnings TEXT NOT NULL DEFAULT '[]',
                errors TEXT NOT NULL DEFAULT '[]',
                actions TEXT NOT NULL DEFAULT '[]',
                memory_ids TEXT NOT NULL DEFAULT '[]',
                metrics TEXT NOT NULL DEFAULT 'null',
                validation TEXT NOT NULL DEFAULT '{"status":"not_run"}',
                audit_id TEXT,
                retry_of TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                scope TEXT NOT NULL,
                scope_workspace TEXT,
                scope_skill TEXT,
                scope_tool TEXT,
                scope_application TEXT,
                scope_domain TEXT,
                content TEXT NOT NULL,
                source_run_id TEXT,
                confidence REAL NOT NULL,
                approval TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                use_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                last_used_at TEXT,
                expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS skills (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                definition TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_tools (
                name TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                input_schema TEXT NOT NULL,
                output_schema TEXT,
                scopes TEXT NOT NULL,
                enabled_by_default BOOLEAN NOT NULL DEFAULT 0,
                enabled BOOLEAN NOT NULL DEFAULT 0,
                source TEXT NOT NULL,
                plugin_id TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_tool_grants (
                client_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (client_id, tool_name)
            );

            CREATE TABLE IF NOT EXISTS clipboard_history (
                id TEXT PRIMARY KEY,
                text_hash TEXT NOT NULL UNIQUE,
                text TEXT NOT NULL,
                first_copied_at TEXT NOT NULL,
                last_copied_at TEXT NOT NULL,
                used_count INTEGER NOT NULL DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_features_plugin ON features(plugin_id);
            CREATE INDEX IF NOT EXISTS idx_plugin_data_plugin ON plugin_data(plugin_id);
            CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_log_status_timestamp ON audit_log(status, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_log_tool_timestamp ON audit_log(tool_name, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_audit_log_client_timestamp ON audit_log(client_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_task_runs_created_at ON task_runs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_task_runs_status_updated_at ON task_runs(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_task_runs_capability_created_at ON task_runs(capability_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_items_active_updated_at ON memory_items(enabled, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_items_source_run ON memory_items(source_run_id);
            CREATE INDEX IF NOT EXISTS idx_skills_enabled_updated_at ON skills(enabled, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_agent_tool_grants_tool ON agent_tool_grants(tool_name);
            CREATE INDEX IF NOT EXISTS idx_clipboard_history_last_copied_at ON clipboard_history(last_copied_at DESC);
            "#,
        )?;
        ensure_memory_scope_columns(&conn)?;
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_memory_scope_tool_updated_at
                ON memory_items(enabled, scope_tool, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_scope_workspace_updated_at
                ON memory_items(enabled, scope_workspace, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_expiry
                ON memory_items(enabled, expires_at);
            "#,
        )?;
        Ok(())
    }

    // ---- Plugin CRUD ----

    /// Saves a plugin record to the database.
    ///
    /// If a plugin with the same ID already exists, its metadata is updated in place so
    /// child rows such as plugin documents and attachments remain intact.
    pub fn save_plugin(&self, plugin: &Plugin) -> Result<()> {
        let conn = self.conn.lock();
        Self::upsert_plugin(&conn, plugin)
    }

    /// Atomically saves plugin metadata and replaces that plugin's feature index.
    pub fn save_plugin_with_features(&self, plugin: &Plugin, features: &[Feature]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        Self::upsert_plugin(&tx, plugin)?;
        Self::replace_features(&tx, &plugin.id, features)?;
        tx.commit()?;
        Ok(())
    }

    fn upsert_plugin(conn: &Connection, plugin: &Plugin) -> Result<()> {
        let config_json = serde_json::to_string(&plugin.manifest)?;
        conn.execute(
            r#"
            INSERT INTO plugins (id, name, version, path, enabled, config, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                path = excluded.path,
                enabled = excluded.enabled,
                config = excluded.config,
                updated_at = excluded.updated_at
            "#,
            params![
                plugin.id,
                plugin.name,
                plugin.version,
                plugin.path,
                plugin.enabled,
                config_json,
                plugin.created_at,
                plugin.updated_at,
            ],
        )?;
        Ok(())
    }

    fn replace_features(conn: &Connection, plugin_id: &str, features: &[Feature]) -> Result<()> {
        conn.execute(
            "DELETE FROM features WHERE plugin_id = ?1",
            params![plugin_id],
        )?;

        let mut stmt = conn.prepare(
            r#"
            INSERT OR REPLACE INTO features (code, plugin_id, label, icon, explain, cmds, main_push, priority)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
        )?;

        for feature in features {
            let cmds_json = serde_json::to_string(&feature.cmds)?;
            let label = feature
                .label
                .clone()
                .unwrap_or_else(|| feature.code.clone());
            let priority = 0i32;

            stmt.execute(params![
                feature.code,
                plugin_id,
                label,
                feature.icon,
                feature.explain,
                cmds_json,
                feature.main_push,
                priority,
            ])?;
        }

        Ok(())
    }

    /// Retrieves a plugin by its ID.
    ///
    /// # Errors
    ///
    /// Returns `AToolsError::Plugin` if the plugin is not found.
    pub fn get_plugin(&self, id: &str) -> Result<Plugin> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, version, path, enabled, config, created_at, updated_at FROM plugins WHERE id = ?1",
        )?;

        let plugin = stmt
            .query_row(params![id], |row| {
                let config_str: String = row.get(5)?;
                let manifest: PluginManifest = serde_json::from_str(&config_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(Plugin {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    path: row.get(3)?,
                    enabled: row.get(4)?,
                    manifest,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })
            .map_err(|_| AToolsError::Plugin(format!("Plugin not found: {}", id)))?;

        Ok(plugin)
    }

    /// Lists all installed plugins.
    pub fn list_plugins(&self) -> Result<Vec<Plugin>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, version, path, enabled, config, created_at, updated_at FROM plugins ORDER BY updated_at DESC",
        )?;

        let plugins = stmt
            .query_map([], |row| {
                let config_str: String = row.get(5)?;
                let manifest: PluginManifest = serde_json::from_str(&config_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                Ok(Plugin {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    path: row.get(3)?,
                    enabled: row.get(4)?,
                    manifest,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(plugins)
    }

    /// Deletes a plugin and all associated data (features, documents, attachments).
    pub fn delete_plugin(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let rows = conn.execute("DELETE FROM plugins WHERE id = ?1", params![id])?;
        if rows == 0 {
            return Err(AToolsError::Plugin(format!("Plugin not found: {}", id)));
        }
        // Cascade deletes handle features, plugin_data, and attachments
        Ok(())
    }

    // ---- Feature indexing ----

    /// Indexes features for a plugin, replacing any existing entries.
    ///
    /// This is typically called when a plugin is installed or updated.
    pub fn index_features(&self, plugin_id: &str, features: &[Feature]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        Self::replace_features(&tx, plugin_id, features)?;
        tx.commit()?;
        Ok(())
    }

    /// Retrieves all indexed features across all plugins, joined with plugin metadata.
    pub fn all_features(&self) -> Result<Vec<FeatureEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT f.code, f.plugin_id, p.name AS plugin_name, f.label, f.icon, f.explain, f.cmds, f.main_push, f.priority
            FROM features f
            JOIN plugins p ON f.plugin_id = p.id
            WHERE p.enabled = 1
            ORDER BY f.priority DESC, f.code ASC
            "#,
        )?;

        let features = stmt
            .query_map([], |row| {
                let cmds_str: String = row.get(6)?;
                let cmds: Vec<_> = serde_json::from_str(&cmds_str).unwrap_or_default();
                Ok(FeatureEntry {
                    code: row.get(0)?,
                    plugin_id: row.get(1)?,
                    plugin_name: row.get(2)?,
                    label: row.get(3)?,
                    icon: row.get(4)?,
                    explain: row.get(5)?,
                    cmds,
                    main_push: row.get(7)?,
                    priority: row.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(features)
    }

    /// Looks up a single feature by its code.
    ///
    /// # Errors
    ///
    /// Returns `AToolsError::FeatureNotFound` if no feature matches the code.
    pub fn get_feature(&self, code: &str) -> Result<FeatureEntry> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT f.code, f.plugin_id, p.name AS plugin_name, f.label, f.icon, f.explain, f.cmds, f.main_push, f.priority
            FROM features f
            JOIN plugins p ON f.plugin_id = p.id
            WHERE f.code = ?1
            "#,
        )?;

        let feature = stmt
            .query_row(params![code], |row| {
                let cmds_str: String = row.get(6)?;
                let cmds: Vec<_> = serde_json::from_str(&cmds_str).unwrap_or_default();
                Ok(FeatureEntry {
                    code: row.get(0)?,
                    plugin_id: row.get(1)?,
                    plugin_name: row.get(2)?,
                    label: row.get(3)?,
                    icon: row.get(4)?,
                    explain: row.get(5)?,
                    cmds,
                    main_push: row.get(7)?,
                    priority: row.get(8)?,
                })
            })
            .map_err(|_| AToolsError::FeatureNotFound(code.to_string()))?;

        Ok(feature)
    }

    // ---- Plugin data (PouchDB-compatible document store) ----

    /// Inserts or updates a document in a plugin's data store.
    ///
    /// If the document already exists, its revision is updated.
    pub fn plugin_data_put(&self, plugin_id: &str, doc: &Document) -> Result<()> {
        let conn = self.conn.lock();
        let rev = generate_rev();
        let data_json = serde_json::to_string(&doc.data)?;

        conn.execute(
            r#"
            INSERT INTO plugin_data (plugin_id, _id, data, rev)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(plugin_id, _id) DO UPDATE SET
                data = excluded.data,
                rev = excluded.rev
            "#,
            params![plugin_id, doc.id, data_json, rev],
        )?;

        Ok(())
    }

    /// Retrieves a single document by ID from a plugin's data store.
    pub fn plugin_data_get(&self, plugin_id: &str, doc_id: &str) -> Result<Option<Document>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT _id, data, rev FROM plugin_data WHERE plugin_id = ?1 AND _id = ?2")?;

        let result = stmt.query_row(params![plugin_id, doc_id], |row| {
            let id: String = row.get(0)?;
            let data_str: String = row.get(1)?;
            let rev: String = row.get(2)?;
            let data: serde_json::Value =
                serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
            Ok(Document {
                id,
                rev: Some(rev),
                data,
            })
        });

        match result {
            Ok(doc) => Ok(Some(doc)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Removes a document by ID from a plugin's data store.
    pub fn plugin_data_remove(&self, plugin_id: &str, doc_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM plugin_data WHERE plugin_id = ?1 AND _id = ?2",
            params![plugin_id, doc_id],
        )?;
        Ok(())
    }

    /// Returns all documents in a plugin's data store.
    pub fn plugin_data_all(&self, plugin_id: &str) -> Result<Vec<Document>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT _id, data, rev FROM plugin_data WHERE plugin_id = ?1")?;

        let docs = stmt
            .query_map(params![plugin_id], |row| {
                let id: String = row.get(0)?;
                let data_str: String = row.get(1)?;
                let rev: String = row.get(2)?;
                let data: serde_json::Value =
                    serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
                Ok(Document {
                    id,
                    rev: Some(rev),
                    data,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(docs)
    }

    /// Bulk-inserts or updates multiple documents.
    pub fn plugin_data_bulk(&self, plugin_id: &str, docs: &[Document]) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;

        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO plugin_data (plugin_id, _id, data, rev)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(plugin_id, _id) DO UPDATE SET
                    data = excluded.data,
                    rev = excluded.rev
                "#,
            )?;

            for doc in docs {
                let rev = generate_rev();
                let data_json = serde_json::to_string(&doc.data)?;
                stmt.execute(params![plugin_id, doc.id, data_json, rev])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    // ---- Attachment storage ----

    /// Stores a binary attachment associated with a plugin document.
    pub fn put_attachment(
        &self,
        plugin_id: &str,
        doc_id: &str,
        name: &str,
        data: &[u8],
        content_type: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO plugin_data_attachments
            (plugin_id, doc_id, name, data, content_type)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![plugin_id, doc_id, name, data, content_type],
        )?;
        Ok(())
    }

    /// Retrieves a binary attachment.
    pub fn get_attachment(
        &self,
        plugin_id: &str,
        doc_id: &str,
        name: &str,
    ) -> Result<Option<(Vec<u8>, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT data, content_type FROM plugin_data_attachments WHERE plugin_id = ?1 AND doc_id = ?2 AND name = ?3"
        )?;

        let result = stmt.query_row(params![plugin_id, doc_id, name], |row| {
            let data: Vec<u8> = row.get(0)?;
            let content_type: String = row.get(1)?;
            Ok((data, content_type))
        });

        match result {
            Ok(attachment) => Ok(Some(attachment)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes an attachment.
    pub fn delete_attachment(&self, plugin_id: &str, doc_id: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "DELETE FROM plugin_data_attachments WHERE plugin_id = ?1 AND doc_id = ?2 AND name = ?3",
            params![plugin_id, doc_id, name],
        )?;
        Ok(rows > 0)
    }

    // ---- Settings (key-value) ----

    /// Retrieves a setting value by key.
    ///
    /// Returns None if the key does not exist.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;

        let result = stmt.query_row(params![key], |row| row.get::<_, String>(0));

        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Sets a setting value.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Deletes a setting.
    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(rows > 0)
    }

    // ---- Clipboard history ----

    pub fn record_clipboard_text(
        &self,
        text: &str,
        copied_at: &str,
    ) -> Result<ClipboardHistoryEntry> {
        let text = text.trim();
        if text.is_empty() {
            return Err(AToolsError::Config(
                "Clipboard text history cannot store empty text".to_string(),
            ));
        }
        let text_hash = stable_text_hash(text);
        let id = format!("clip-{}", text_hash);
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO clipboard_history
            (id, text_hash, text, first_copied_at, last_copied_at, used_count)
            VALUES (?1, ?2, ?3, ?4, ?4, 1)
            ON CONFLICT(text_hash) DO UPDATE SET
                text = excluded.text,
                last_copied_at = excluded.last_copied_at,
                used_count = clipboard_history.used_count + 1
            "#,
            params![id, text_hash, text, copied_at],
        )?;
        clipboard_history_by_hash(&conn, &text_hash)
    }

    pub fn search_clipboard_history(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ClipboardHistoryEntry>> {
        let conn = self.conn.lock();
        let limit = limit.clamp(1, 500) as i64;
        let query = query.trim();
        if query.is_empty() {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, text, first_copied_at, last_copied_at, used_count
                FROM clipboard_history
                ORDER BY last_copied_at DESC
                LIMIT ?1
                "#,
            )?;
            return stmt
                .query_map(params![limit], clipboard_history_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into);
        }

        let like = format!("%{}%", query.to_lowercase());
        let mut stmt = conn.prepare(
            r#"
            SELECT id, text, first_copied_at, last_copied_at, used_count
            FROM clipboard_history
            WHERE LOWER(text) LIKE ?1
            ORDER BY last_copied_at DESC
            LIMIT ?2
            "#,
        )?;
        let entries = stmt
            .query_map(params![like, limit], clipboard_history_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(AToolsError::from)?;
        Ok(entries)
    }

    pub fn prune_clipboard_history(&self, older_than: &str) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM clipboard_history WHERE last_copied_at < ?1",
            params![older_than],
        )?)
    }

    pub fn clear_clipboard_history(&self) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM clipboard_history", [])?)
    }

    pub fn export_clipboard_history_json(&self, limit: usize) -> Result<String> {
        let entries = self.search_clipboard_history("", limit)?;
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "version": 1,
            "exportedAt": crate::utils::now_iso(),
            "count": entries.len(),
            "entries": entries,
        }))?)
    }

    // ---- Agent tool registry and grants ----

    pub fn sync_agent_tools(&self, tools: &[ToolDefinition]) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO agent_tools
                (name, description, input_schema, output_schema, scopes, enabled_by_default, enabled, source, plugin_id, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(name) DO UPDATE SET
                    description = excluded.description,
                    input_schema = excluded.input_schema,
                    output_schema = excluded.output_schema,
                    scopes = excluded.scopes,
                    enabled_by_default = excluded.enabled_by_default,
                    source = excluded.source,
                    plugin_id = excluded.plugin_id,
                    updated_at = excluded.updated_at
                "#,
            )?;
            for tool in tools {
                stmt.execute(params![
                    tool.name,
                    tool.description,
                    serde_json::to_string(&tool.input_schema)?,
                    tool.output_schema
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    serde_json::to_string(&tool.scopes)?,
                    tool.enabled_by_default,
                    tool.enabled,
                    tool.source,
                    tool.plugin_id,
                    crate::utils::now_iso(),
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_agent_tools(&self) -> Result<Vec<ToolDefinition>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT name, description, input_schema, output_schema, scopes, enabled_by_default, enabled, source, plugin_id
            FROM agent_tools
            ORDER BY source ASC, name ASC
            "#,
        )?;

        let tools = stmt
            .query_map([], agent_tool_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tools)
    }

    pub fn get_agent_tool(&self, name: &str) -> Result<Option<ToolDefinition>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT name, description, input_schema, output_schema, scopes, enabled_by_default, enabled, source, plugin_id
            FROM agent_tools
            WHERE name = ?1
            "#,
        )?;

        let result = stmt.query_row(params![name], agent_tool_from_row);
        match result {
            Ok(tool) => Ok(Some(tool)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_agent_tool_enabled(&self, name: &str, enabled: bool) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "UPDATE agent_tools SET enabled = ?2, updated_at = ?3 WHERE name = ?1",
            params![name, enabled, crate::utils::now_iso()],
        )?;
        Ok(rows > 0)
    }

    pub fn delete_agent_tools_by_source_except(
        &self,
        source: &str,
        keep_names: &[String],
    ) -> Result<usize> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT name FROM agent_tools WHERE source = ?1")?;
        let existing = stmt
            .query_map(params![source], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let keep = keep_names.iter().collect::<std::collections::BTreeSet<_>>();
        let mut deleted = 0usize;
        for name in existing {
            if keep.contains(&name) {
                continue;
            }
            deleted += conn.execute("DELETE FROM agent_tools WHERE name = ?1", params![name])?;
        }
        Ok(deleted)
    }

    pub fn grant_agent_tool(&self, client_id: &str, tool_name: &str) -> Result<()> {
        let conn = self.conn.lock();
        let now = crate::utils::now_iso();
        conn.execute(
            r#"
            INSERT INTO agent_tool_grants (client_id, tool_name, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?3)
            ON CONFLICT(client_id, tool_name) DO UPDATE SET updated_at = excluded.updated_at
            "#,
            params![client_id, tool_name, now],
        )?;
        Ok(())
    }

    pub fn revoke_agent_tool(&self, client_id: &str, tool_name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "DELETE FROM agent_tool_grants WHERE client_id = ?1 AND tool_name = ?2",
            params![client_id, tool_name],
        )?;
        Ok(rows > 0)
    }

    pub fn is_agent_tool_granted(&self, client_id: &str, tool_name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT 1 FROM agent_tool_grants WHERE client_id = ?1 AND tool_name = ?2 LIMIT 1",
        )?;
        let result = stmt.query_row(params![client_id, tool_name], |_| Ok(()));
        match result {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list_agent_tool_grants(&self) -> Result<Vec<AgentToolGrant>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT client_id, tool_name, created_at, updated_at
            FROM agent_tool_grants
            ORDER BY updated_at DESC, client_id ASC, tool_name ASC
            "#,
        )?;
        let grants = stmt
            .query_map([], |row| {
                Ok(AgentToolGrant {
                    client_id: row.get(0)?,
                    tool_name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(grants)
    }

    // ---- Task runs ----

    pub fn upsert_task_run(&self, run: &TaskRun) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO task_runs
            (id, capability_id, initiator_type, client_id, status, input, output, summary,
             progress, artifacts, warnings, errors, actions, memory_ids, metrics, validation,
             audit_id, retry_of, created_at, updated_at, started_at, finished_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
            "#,
            params![
                run.id,
                run.capability_id,
                task_run_initiator_type_to_str(run.initiator.kind),
                run.initiator.client_id,
                run.status.as_str(),
                serde_json::to_string(&run.input)?,
                serde_json::to_string(&run.output)?,
                run.summary,
                run.progress.map(i64::from),
                serde_json::to_string(&run.artifacts)?,
                serde_json::to_string(&run.warnings)?,
                serde_json::to_string(&run.errors)?,
                serde_json::to_string(&run.actions)?,
                serde_json::to_string(&run.memory_ids)?,
                serde_json::to_string(&run.metrics)?,
                serde_json::to_string(&run.validation)?,
                run.audit_id,
                run.retry_of,
                run.created_at,
                run.updated_at,
                run.started_at,
                run.finished_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_task_run(&self, id: &str) -> Result<Option<TaskRun>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, capability_id, initiator_type, client_id, status, input, output, summary,
                   progress, artifacts, warnings, errors, actions, memory_ids, metrics, validation,
                   audit_id, retry_of, created_at, updated_at, started_at, finished_at
            FROM task_runs
            WHERE id = ?1
            "#,
        )?;
        let mut rows = stmt.query(params![id])?;
        rows.next()?
            .map(task_run_from_row)
            .transpose()
            .map_err(Into::into)
    }

    pub fn list_task_runs(&self, limit: usize) -> Result<Vec<TaskRun>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, capability_id, initiator_type, client_id, status, input, output, summary,
                   progress, artifacts, warnings, errors, actions, memory_ids, metrics, validation,
                   audit_id, retry_of, created_at, updated_at, started_at, finished_at
            FROM task_runs
            ORDER BY created_at DESC, id DESC
            LIMIT ?1
            "#,
        )?;
        let runs = stmt
            .query_map(params![limit.clamp(1, 5000) as i64], task_run_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(runs)
    }

    // ---- Skills ----

    pub fn upsert_skill(&self, skill: &SkillDefinition) -> Result<()> {
        skill.validate()?;
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO skills (id, name, description, definition, enabled, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                definition = excluded.definition,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at
            "#,
            params![
                skill.id,
                skill.name,
                skill.description,
                serde_json::to_string(skill)?,
                skill.enabled,
                skill.created_at,
                skill.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_skill(&self, id: &str) -> Result<Option<SkillDefinition>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT definition, enabled, created_at, updated_at FROM skills WHERE id = ?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        rows.next()?
            .map(skill_from_row)
            .transpose()
            .map_err(Into::into)
    }

    pub fn list_skills(
        &self,
        include_disabled: bool,
        limit: usize,
    ) -> Result<Vec<SkillDefinition>> {
        let conn = self.conn.lock();
        let sql = if include_disabled {
            "SELECT definition, enabled, created_at, updated_at FROM skills ORDER BY updated_at DESC, id ASC LIMIT ?1"
        } else {
            "SELECT definition, enabled, created_at, updated_at FROM skills WHERE enabled = 1 ORDER BY updated_at DESC, id ASC LIMIT ?1"
        };
        let mut stmt = conn.prepare(sql)?;
        let skills = stmt
            .query_map(params![limit.clamp(1, 5000) as i64], skill_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(skills)
    }

    pub fn set_skill_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        let Some(mut skill) = self.get_skill(id)? else {
            return Ok(false);
        };
        skill.enabled = enabled;
        skill.updated_at = crate::utils::now_iso();
        self.upsert_skill(&skill)?;
        Ok(true)
    }

    pub fn delete_skill(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM skills WHERE id = ?1", params![id])? > 0)
    }

    pub fn export_skills_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(
            &self.list_skills(true, 5000)?,
        )?)
    }

    pub fn storage_size_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let page_count = conn.query_row("PRAGMA page_count", [], |row| row.get::<_, i64>(0))?;
        let page_size = conn.query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))?;
        Ok(page_count.max(0) as u64 * page_size.max(0) as u64)
    }

    // ---- Execution memory ----

    pub fn upsert_memory_item(&self, item: &MemoryItem) -> Result<()> {
        validate_memory_content(&item.content)?;
        if !(0.0..=1.0).contains(&item.confidence) {
            return Err(AToolsError::Config(
                "Memory confidence must be between 0 and 1".to_string(),
            ));
        }
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO memory_items
            (id, type, scope, scope_workspace, scope_skill, scope_tool, scope_application,
             scope_domain, content, source_run_id, confidence, approval, enabled, use_count,
             success_count, last_used_at, expires_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18, ?19)
            "#,
            params![
                item.id,
                memory_type_to_str(item.kind),
                serde_json::to_string(&item.scope)?,
                item.scope.workspace,
                item.scope.skill,
                item.scope.tool,
                item.scope.application,
                item.scope.domain,
                serde_json::to_string(&item.content)?,
                item.source_run_id,
                item.confidence,
                memory_approval_to_str(item.approval),
                item.enabled,
                item.use_count as i64,
                item.success_count as i64,
                item.last_used_at,
                item.expires_at,
                item.created_at,
                item.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_memory_item(&self, id: &str) -> Result<Option<MemoryItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items WHERE id = ?1
            "#,
        )?;
        let mut rows = stmt.query(params![id])?;
        rows.next()?
            .map(memory_item_from_row)
            .transpose()
            .map_err(Into::into)
    }

    pub fn list_memory_items(
        &self,
        include_disabled: bool,
        limit: usize,
    ) -> Result<Vec<MemoryItem>> {
        let conn = self.conn.lock();
        let sql = if include_disabled {
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items ORDER BY updated_at DESC, id DESC LIMIT ?1
            "#
        } else {
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items WHERE enabled = 1 ORDER BY updated_at DESC, id DESC LIMIT ?1
            "#
        };
        let mut stmt = conn.prepare(sql)?;
        let items = stmt
            .query_map(params![limit.clamp(1, 5000) as i64], memory_item_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn find_memory_items(
        &self,
        context: &MemoryScope,
        limit: usize,
    ) -> Result<Vec<MemoryItem>> {
        let now = crate::utils::now_iso();
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, type, scope, content, source_run_id, confidence, approval, enabled,
                   use_count, success_count, last_used_at, expires_at, created_at, updated_at
            FROM memory_items
            WHERE enabled = 1
              AND (expires_at IS NULL OR expires_at > ?6)
              AND (scope_workspace IS NULL OR (?1 IS NOT NULL AND scope_workspace = ?1))
              AND (scope_skill IS NULL OR (?2 IS NOT NULL AND scope_skill = ?2))
              AND (scope_tool IS NULL OR (?3 IS NOT NULL AND scope_tool = ?3))
              AND (scope_application IS NULL OR (?4 IS NOT NULL AND scope_application = ?4))
              AND (scope_domain IS NULL OR (?5 IS NOT NULL AND scope_domain = ?5))
            ORDER BY
              ((scope_workspace IS NOT NULL) + (scope_skill IS NOT NULL) +
               (scope_tool IS NOT NULL) + (scope_application IS NOT NULL) +
               (scope_domain IS NOT NULL)) DESC,
              confidence DESC,
              updated_at DESC,
              id ASC
            LIMIT ?7
            "#,
        )?;
        let items = stmt
            .query_map(
                params![
                    context.workspace.as_deref(),
                    context.skill.as_deref(),
                    context.tool.as_deref(),
                    context.application.as_deref(),
                    context.domain.as_deref(),
                    now,
                    limit.clamp(1, 100) as i64,
                ],
                memory_item_from_row,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn set_memory_item_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "UPDATE memory_items SET enabled = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, enabled, crate::utils::now_iso()],
        )? > 0)
    }

    pub fn record_memory_use(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let now = crate::utils::now_iso();
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute(
                r#"
                UPDATE memory_items
                SET use_count = use_count + 1,
                    last_used_at = ?2,
                    updated_at = ?2
                WHERE id = ?1
                "#,
                params![id, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn record_memory_success(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE memory_items SET success_count = success_count + 1 WHERE id = ?1",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_memory_item(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM memory_items WHERE id = ?1", params![id])? > 0)
    }

    pub fn clear_memory_items(&self) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM memory_items", [])?)
    }

    pub fn export_memory_items_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(
            &self.list_memory_items(true, 5000)?,
        )?)
    }

    // ---- Audit log ----

    pub fn insert_audit_entry(&self, entry: &AuditLogEntry) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO audit_log
            (id, timestamp, client_id, tool_name, input, output, status, duration_ms, error)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                entry.id,
                entry.timestamp,
                entry.client_id,
                entry.tool_name,
                serde_json::to_string(&entry.input)?,
                serde_json::to_string(&entry.output)?,
                audit_status_to_str(&entry.status),
                entry.duration_ms as i64,
                entry.error,
            ],
        )?;
        Ok(())
    }

    pub fn list_audit_entries(&self, limit: usize) -> Result<Vec<AuditLogEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, timestamp, client_id, tool_name, input, output, status, duration_ms, error
            FROM audit_log
            ORDER BY timestamp DESC
            LIMIT ?1
            "#,
        )?;

        let entries = stmt
            .query_map(params![limit as i64], audit_entry_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(entries)
    }

    pub fn query_audit_entries(&self, query: &AuditLogQuery) -> Result<Vec<AuditLogEntry>> {
        Ok(self.query_audit_entries_page(query)?.entries)
    }

    pub fn query_audit_entries_page(&self, query: &AuditLogQuery) -> Result<AuditLogPage> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, timestamp, client_id, tool_name, input, output, status, duration_ms, error
            FROM audit_log
            ORDER BY timestamp DESC
            "#,
        )?;
        let limit = query.limit.clamp(1, 5000);
        let offset = query.offset.min(usize::MAX - limit);
        let entries = stmt
            .query_map([], audit_entry_from_row)?
            .filter_map(|entry| match entry {
                Ok(entry) if audit_entry_matches_query(&entry, query) => Some(Ok(entry)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let total = entries.len();
        let entries = entries.into_iter().skip(offset).take(limit).collect();
        Ok(AuditLogPage {
            entries,
            total,
            limit,
            offset,
        })
    }

    pub fn clear_audit_entries(&self) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM audit_log", [])?)
    }

    pub fn prune_audit_entries(
        &self,
        older_than: Option<&str>,
        keep_latest: Option<usize>,
    ) -> Result<usize> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let mut deleted = 0;

        if let Some(cutoff) = older_than.map(str::trim).filter(|value| !value.is_empty()) {
            deleted += tx.execute(
                "DELETE FROM audit_log WHERE timestamp < ?1",
                params![cutoff],
            )?;
        }

        if let Some(limit) = keep_latest {
            deleted += tx.execute(
                r#"
                DELETE FROM audit_log
                WHERE id NOT IN (
                    SELECT id FROM audit_log
                    ORDER BY timestamp DESC, id DESC
                    LIMIT ?1
                )
                "#,
                params![limit as i64],
            )?;
        }

        tx.commit()?;
        Ok(deleted)
    }

    pub fn delete_audit_entries_for_client(&self, client_id: &str) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM audit_log WHERE client_id = ?1",
            params![client_id],
        )?)
    }

    pub fn export_audit_entries_jsonl(&self, limit: usize) -> Result<String> {
        let entries = self.list_audit_entries(limit)?;
        export_audit_entries_jsonl(entries)
    }

    pub fn export_audit_entries_jsonl_filtered(&self, query: &AuditLogQuery) -> Result<String> {
        let entries = self.query_audit_entries(query)?;
        export_audit_entries_jsonl(entries)
    }
}

fn export_audit_entries_jsonl(entries: Vec<AuditLogEntry>) -> Result<String> {
    let mut output = String::new();
    for entry in entries {
        output.push_str(&serde_json::to_string(&entry)?);
        output.push('\n');
    }
    Ok(output)
}

fn ensure_memory_scope_columns(conn: &Connection) -> Result<()> {
    let existing = {
        let mut stmt = conn.prepare("PRAGMA table_info(memory_items)")?;
        stmt.query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<std::collections::BTreeSet<_>, _>>()?
    };
    for column in [
        "scope_workspace",
        "scope_skill",
        "scope_tool",
        "scope_application",
        "scope_domain",
    ] {
        if !existing.contains(column) {
            conn.execute(
                &format!("ALTER TABLE memory_items ADD COLUMN {column} TEXT"),
                [],
            )?;
        }
    }

    // Backfill databases created before structured scope columns were introduced.
    conn.execute_batch(
        r#"
        UPDATE memory_items SET
            scope_workspace = json_extract(scope, '$.workspace'),
            scope_skill = json_extract(scope, '$.skill'),
            scope_tool = json_extract(scope, '$.tool'),
            scope_application = json_extract(scope, '$.application'),
            scope_domain = json_extract(scope, '$.domain')
        WHERE scope_workspace IS NULL
          AND scope_skill IS NULL
          AND scope_tool IS NULL
          AND scope_application IS NULL
          AND scope_domain IS NULL
          AND scope <> '{}';
        "#,
    )?;
    Ok(())
}

fn task_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRun> {
    let initiator_type: String = row.get(2)?;
    let status: String = row.get(4)?;
    let input: String = row.get(5)?;
    let output: String = row.get(6)?;
    let progress: Option<i64> = row.get(8)?;
    let artifacts: String = row.get(9)?;
    let warnings: String = row.get(10)?;
    let errors: String = row.get(11)?;
    let actions: String = row.get(12)?;
    let memory_ids: String = row.get(13)?;
    let metrics: String = row.get(14)?;
    let validation: String = row.get(15)?;

    Ok(TaskRun {
        id: row.get(0)?,
        capability_id: row.get(1)?,
        initiator: TaskRunInitiator {
            kind: task_run_initiator_type_from_str(&initiator_type),
            client_id: row.get(3)?,
        },
        status: TaskRunStatus::from_storage(&status),
        input: serde_json::from_str(&input).unwrap_or(Value::Null),
        output: serde_json::from_str(&output).unwrap_or(Value::Null),
        summary: row.get(7)?,
        progress: progress.map(|value| value.clamp(0, 100) as u8),
        artifacts: serde_json::from_str::<Vec<Artifact>>(&artifacts).unwrap_or_default(),
        warnings: serde_json::from_str::<Vec<TaskIssue>>(&warnings).unwrap_or_default(),
        errors: serde_json::from_str::<Vec<TaskIssue>>(&errors).unwrap_or_default(),
        actions: serde_json::from_str::<Vec<ResultAction>>(&actions).unwrap_or_default(),
        memory_ids: serde_json::from_str::<Vec<String>>(&memory_ids).unwrap_or_default(),
        metrics: serde_json::from_str(&metrics).unwrap_or(Value::Null),
        validation: serde_json::from_str::<TaskValidation>(&validation).unwrap_or_default(),
        audit_id: row.get(16)?,
        retry_of: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        started_at: row.get(20)?,
        finished_at: row.get(21)?,
    })
}

fn skill_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillDefinition> {
    let definition: String = row.get(0)?;
    let mut skill = serde_json::from_str::<SkillDefinition>(&definition).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    skill.enabled = row.get(1)?;
    skill.created_at = row.get(2)?;
    skill.updated_at = row.get(3)?;
    Ok(skill)
}

fn memory_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    let kind: String = row.get(1)?;
    let scope: String = row.get(2)?;
    let content: String = row.get(3)?;
    let approval: String = row.get(6)?;
    let use_count: i64 = row.get(8)?;
    let success_count: i64 = row.get(9)?;
    Ok(MemoryItem {
        id: row.get(0)?,
        kind: memory_type_from_str(&kind),
        scope: serde_json::from_str(&scope).unwrap_or_default(),
        content: serde_json::from_str(&content).unwrap_or(Value::Null),
        source_run_id: row.get(4)?,
        confidence: row.get::<_, f64>(5)?.clamp(0.0, 1.0),
        approval: memory_approval_from_str(&approval),
        enabled: row.get(7)?,
        use_count: use_count.max(0) as u64,
        success_count: success_count.max(0) as u64,
        last_used_at: row.get(10)?,
        expires_at: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn memory_type_to_str(value: MemoryType) -> &'static str {
    match value {
        MemoryType::Preference => "preference",
        MemoryType::WorkspaceFact => "workspace_fact",
        MemoryType::TaskRecipe => "task_recipe",
        MemoryType::Correction => "correction",
        MemoryType::FailureRecovery => "failure_recovery",
    }
}

fn memory_type_from_str(value: &str) -> MemoryType {
    match value {
        "workspace_fact" => MemoryType::WorkspaceFact,
        "task_recipe" => MemoryType::TaskRecipe,
        "correction" => MemoryType::Correction,
        "failure_recovery" => MemoryType::FailureRecovery,
        _ => MemoryType::Preference,
    }
}

fn memory_approval_to_str(value: MemoryApproval) -> &'static str {
    match value {
        MemoryApproval::Explicit => "explicit",
        MemoryApproval::ConfirmedCandidate => "confirmed_candidate",
        MemoryApproval::Temporary => "temporary",
    }
}

fn memory_approval_from_str(value: &str) -> MemoryApproval {
    match value {
        "confirmed_candidate" => MemoryApproval::ConfirmedCandidate,
        "temporary" => MemoryApproval::Temporary,
        _ => MemoryApproval::Explicit,
    }
}

fn task_run_initiator_type_to_str(value: TaskRunInitiatorType) -> &'static str {
    match value {
        TaskRunInitiatorType::Human => "human",
        TaskRunInitiatorType::Agent => "agent",
        TaskRunInitiatorType::Automation => "automation",
    }
}

fn task_run_initiator_type_from_str(value: &str) -> TaskRunInitiatorType {
    match value {
        "human" => TaskRunInitiatorType::Human,
        "automation" => TaskRunInitiatorType::Automation,
        _ => TaskRunInitiatorType::Agent,
    }
}

fn audit_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditLogEntry> {
    let input: String = row.get(4)?;
    let output: String = row.get(5)?;
    let status: String = row.get(6)?;
    let duration_ms: i64 = row.get(7)?;

    Ok(AuditLogEntry {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        client_id: row.get(2)?,
        tool_name: row.get(3)?,
        input: serde_json::from_str(&input).unwrap_or(serde_json::Value::Null),
        output: serde_json::from_str(&output).unwrap_or(serde_json::Value::Null),
        status: audit_status_from_str(&status),
        duration_ms: duration_ms.max(0) as u64,
        error: row.get(8)?,
    })
}

fn audit_entry_matches_query(entry: &AuditLogEntry, query: &AuditLogQuery) -> bool {
    if let Some(status) = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    {
        if !audit_status_matches_filter(&entry.status, status) {
            return false;
        }
    }
    if let Some(tool_name) = query
        .tool_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    {
        if entry.tool_name != tool_name {
            return false;
        }
    }
    if let Some(client_id) = query
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
    {
        if entry.client_id != client_id {
            return false;
        }
    }
    if let Some(text) = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let needle = text.to_lowercase();
        if !audit_entry_search_text(entry).contains(&needle) {
            return false;
        }
    }
    true
}

fn audit_status_matches_filter(status: &AuditStatus, filter: &str) -> bool {
    match filter {
        "success" => matches!(status, AuditStatus::Allowed | AuditStatus::Confirmed),
        "allowed" => matches!(status, AuditStatus::Allowed),
        "confirmed" => matches!(status, AuditStatus::Confirmed),
        "denied" => matches!(status, AuditStatus::Denied),
        "error" => matches!(status, AuditStatus::Error),
        _ => audit_status_to_str(status) == filter,
    }
}

fn audit_entry_search_text(entry: &AuditLogEntry) -> String {
    [
        entry.id.as_str(),
        entry.timestamp.as_str(),
        entry.client_id.as_str(),
        entry.tool_name.as_str(),
        audit_status_to_str(&entry.status),
        entry.error.as_deref().unwrap_or_default(),
        &serde_json::to_string(&entry.input).unwrap_or_default(),
        &serde_json::to_string(&entry.output).unwrap_or_default(),
    ]
    .join("\n")
    .to_lowercase()
}

fn audit_status_to_str(status: &AuditStatus) -> &'static str {
    match status {
        AuditStatus::Allowed => "allowed",
        AuditStatus::Confirmed => "confirmed",
        AuditStatus::Denied => "denied",
        AuditStatus::Error => "error",
    }
}

fn agent_tool_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolDefinition> {
    let input_schema: String = row.get(2)?;
    let output_schema: Option<String> = row.get(3)?;
    let scopes: String = row.get(4)?;
    let input_schema = serde_json::from_str(&input_schema).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let output_schema = output_schema
        .map(|value| {
            serde_json::from_str(&value).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })
        })
        .transpose()?;
    let scopes: Vec<PermissionScope> = serde_json::from_str(&scopes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;

    Ok(ToolDefinition {
        name: row.get(0)?,
        description: row.get(1)?,
        input_schema,
        output_schema,
        scopes,
        enabled_by_default: row.get(5)?,
        enabled: row.get(6)?,
        source: row.get(7)?,
        plugin_id: row.get(8)?,
    })
}

fn clipboard_history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardHistoryEntry> {
    let used_count: i64 = row.get(4)?;
    Ok(ClipboardHistoryEntry {
        id: row.get(0)?,
        text: row.get(1)?,
        first_copied_at: row.get(2)?,
        last_copied_at: row.get(3)?,
        used_count: used_count.max(0) as u32,
    })
}

fn clipboard_history_by_hash(conn: &Connection, text_hash: &str) -> Result<ClipboardHistoryEntry> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, text, first_copied_at, last_copied_at, used_count
        FROM clipboard_history
        WHERE text_hash = ?1
        "#,
    )?;
    Ok(stmt.query_row(params![text_hash], clipboard_history_from_row)?)
}

fn stable_text_hash(value: &str) -> String {
    // FNV-1a is sufficient here: the hash is only for local de-duplication, not security.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn audit_status_from_str(status: &str) -> AuditStatus {
    match status {
        "allowed" => AuditStatus::Allowed,
        "confirmed" => AuditStatus::Confirmed,
        "denied" => AuditStatus::Denied,
        "error" => AuditStatus::Error,
        _ => AuditStatus::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::models::{Cmd, Feature, Plugin, PluginManifest};

    fn create_test_plugin(id: &str, name: &str) -> Plugin {
        let manifest = PluginManifest {
            name: name.to_string(),
            version: "1.0.0".to_string(),
            main: Some("index.js".to_string()),
            logo: Some("logo.png".to_string()),
            preload: None,
            description: Some("Test plugin".to_string()),
            author: None,
            homepage: None,
            plugin_setting: None,
            features: vec![],
            development: None,
            tools: HashMap::new(),
            permissions: vec![],
        };

        Plugin {
            id: id.to_string(),
            name: name.to_string(),
            version: "1.0.0".to_string(),
            path: format!("/tmp/{}", id),
            created_at: crate::utils::now_iso(),
            updated_at: crate::utils::now_iso(),
            enabled: true,
            manifest,
        }
    }

    fn create_test_feature(code: &str) -> Feature {
        Feature {
            code: code.to_string(),
            label: None,
            explain: format!("Feature {}", code),
            icon: None,
            main_push: true,
            main_hide: false,
            cmds: vec![Cmd::Text(code.to_string())],
        }
    }

    #[test]
    fn test_database_operations() {
        let db = Database::in_memory().unwrap();

        // Test plugin operations
        let plugin = create_test_plugin("test-plugin-id", "Test Plugin");
        db.save_plugin(&plugin).unwrap();
        let retrieved = db.get_plugin("test-plugin-id").unwrap();
        assert_eq!(retrieved.name, "Test Plugin");

        // Test feature indexing
        let features = vec![create_test_feature("feature1")];
        db.index_features("test-plugin-id", &features).unwrap();
        let all = db.all_features().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].code, "feature1");

        // Test plugin data
        let doc = crate::models::Document {
            id: "doc1".to_string(),
            rev: None,
            data: serde_json::json!({"key": "value"}),
        };

        db.plugin_data_put("test-plugin-id", &doc).unwrap();
        let retrieved = db
            .plugin_data_get("test-plugin-id", "doc1")
            .unwrap()
            .unwrap();
        assert_eq!(retrieved.data["key"], "value");

        // Test settings
        db.set_setting("theme", "dark").unwrap();
        let theme = db.get_setting("theme").unwrap();
        assert_eq!(theme, Some("dark".to_string()));

        // Test attachments
        db.put_attachment(
            "test-plugin-id",
            "doc1",
            "file.txt",
            b"content",
            "text/plain",
        )
        .unwrap();
        let attachment = db
            .get_attachment("test-plugin-id", "doc1", "file.txt")
            .unwrap()
            .unwrap();
        assert_eq!(attachment.0, b"content");
        assert_eq!(attachment.1, "text/plain");
    }

    #[test]
    fn test_plugin_crud_operations() {
        let db = Database::in_memory().unwrap();

        // Create
        let plugin = create_test_plugin("crud-plugin", "CRUD Plugin");
        db.save_plugin(&plugin).unwrap();

        // Read
        let retrieved = db.get_plugin("crud-plugin").unwrap();
        assert_eq!(retrieved.name, "CRUD Plugin");
        assert_eq!(retrieved.version, "1.0.0");

        // Update
        let mut updated = retrieved;
        updated.version = "2.0.0".to_string();
        updated.updated_at = crate::utils::now_iso();
        db.save_plugin(&updated).unwrap();
        let re_retrieved = db.get_plugin("crud-plugin").unwrap();
        assert_eq!(re_retrieved.version, "2.0.0");

        // Delete
        db.delete_plugin("crud-plugin").unwrap();
        assert!(db.get_plugin("crud-plugin").is_err());
    }

    #[test]
    fn plugin_upsert_preserves_documents_and_attachments() {
        let db = Database::in_memory().unwrap();
        let mut plugin = create_test_plugin("persistent-plugin", "Persistent Plugin");
        plugin.created_at = "2026-06-01T00:00:00Z".to_string();
        plugin.updated_at = plugin.created_at.clone();
        db.save_plugin(&plugin).unwrap();

        let document = Document {
            id: "preferences".to_string(),
            rev: None,
            data: serde_json::json!({"theme": "dark"}),
        };
        db.plugin_data_put(&plugin.id, &document).unwrap();
        db.put_attachment(
            &plugin.id,
            &document.id,
            "avatar.png",
            b"preserved-image",
            "image/png",
        )
        .unwrap();

        plugin.version = "2.0.0".to_string();
        plugin.enabled = false;
        plugin.created_at = "2030-01-01T00:00:00Z".to_string();
        plugin.updated_at = "2026-07-10T00:00:00Z".to_string();
        db.save_plugin(&plugin).unwrap();

        let saved = db.get_plugin(&plugin.id).unwrap();
        assert_eq!(saved.version, "2.0.0");
        assert!(!saved.enabled);
        assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
        assert_eq!(saved.updated_at, "2026-07-10T00:00:00Z");
        assert_eq!(
            db.plugin_data_get(&plugin.id, &document.id)
                .unwrap()
                .unwrap()
                .data,
            document.data
        );
        assert_eq!(
            db.get_attachment(&plugin.id, &document.id, "avatar.png")
                .unwrap()
                .unwrap(),
            (b"preserved-image".to_vec(), "image/png".to_string())
        );
    }

    #[test]
    fn save_plugin_with_features_rolls_back_metadata_features_and_data_on_feature_failure() {
        let db = Database::in_memory().unwrap();

        let competing_plugin = create_test_plugin("competing-plugin", "Competing Plugin");
        db.save_plugin_with_features(&competing_plugin, &[create_test_feature("shared-feature")])
            .unwrap();

        let mut plugin = create_test_plugin("atomic-plugin", "Atomic Plugin");
        plugin.created_at = "2026-06-01T00:00:00Z".to_string();
        plugin.updated_at = plugin.created_at.clone();
        let old_feature = create_test_feature("old-feature");
        db.save_plugin_with_features(&plugin, std::slice::from_ref(&old_feature))
            .unwrap();

        let document = Document {
            id: "state".to_string(),
            rev: None,
            data: serde_json::json!({"preserved": true}),
        };
        db.plugin_data_put(&plugin.id, &document).unwrap();
        db.put_attachment(
            &plugin.id,
            &document.id,
            "state.bin",
            b"atomic-attachment",
            "application/octet-stream",
        )
        .unwrap();

        {
            let conn = db.conn.lock();
            conn.execute_batch(
                r#"
                CREATE TEMP TRIGGER fail_atomic_plugin_feature_insert
                BEFORE INSERT ON features
                WHEN NEW.plugin_id = 'atomic-plugin' AND NEW.code = 'fail-feature'
                BEGIN
                    SELECT RAISE(ABORT, 'injected feature insert failure');
                END;
                "#,
            )
            .unwrap();
        }

        let mut updated = plugin.clone();
        updated.version = "2.0.0".to_string();
        updated.enabled = false;
        updated.updated_at = "2026-07-10T00:00:00Z".to_string();
        let error = db
            .save_plugin_with_features(
                &updated,
                &[
                    create_test_feature("shared-feature"),
                    create_test_feature("fail-feature"),
                ],
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("injected feature insert failure"));

        let saved = db.get_plugin(&plugin.id).unwrap();
        assert_eq!(saved.version, "1.0.0");
        assert!(saved.enabled);
        assert_eq!(saved.created_at, "2026-06-01T00:00:00Z");
        assert_eq!(saved.updated_at, "2026-06-01T00:00:00Z");
        assert_eq!(
            db.get_feature(&old_feature.code).unwrap().plugin_id,
            plugin.id
        );
        assert_eq!(
            db.get_feature("shared-feature").unwrap().plugin_id,
            competing_plugin.id
        );
        assert!(db.get_feature("fail-feature").is_err());
        assert_eq!(
            db.plugin_data_get(&plugin.id, &document.id)
                .unwrap()
                .unwrap()
                .data,
            document.data
        );
        assert_eq!(
            db.get_attachment(&plugin.id, &document.id, "state.bin")
                .unwrap()
                .unwrap()
                .0,
            b"atomic-attachment"
        );
    }

    #[test]
    fn test_list_plugins() {
        let db = Database::in_memory().unwrap();

        let plugin1 = create_test_plugin("plugin1", "Plugin 1");
        let plugin2 = create_test_plugin("plugin2", "Plugin 2");
        let plugin3 = create_test_plugin("plugin3", "Plugin 3");

        db.save_plugin(&plugin1).unwrap();
        db.save_plugin(&plugin2).unwrap();
        db.save_plugin(&plugin3).unwrap();

        let all = db.list_plugins().unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().any(|p| p.id == "plugin1"));
        assert!(all.iter().any(|p| p.id == "plugin2"));
        assert!(all.iter().any(|p| p.id == "plugin3"));
    }

    #[test]
    fn test_feature_indexing_and_search() {
        let db = Database::in_memory().unwrap();

        let plugin = create_test_plugin("search-plugin", "Search Plugin");
        db.save_plugin(&plugin).unwrap();

        let features = vec![
            create_test_feature("calc"),
            create_test_feature("weather"),
            create_test_feature("translate"),
        ];

        db.index_features("search-plugin", &features).unwrap();

        let all = db.all_features().unwrap();
        assert_eq!(all.len(), 3);

        let calc = db.get_feature("calc").unwrap();
        assert_eq!(calc.code, "calc");
        assert_eq!(calc.plugin_id, "search-plugin");

        assert!(db.get_feature("nonexistent").is_err());
    }

    #[test]
    fn test_feature_indexing_reassigns_duplicate_code_to_latest_plugin() {
        let db = Database::in_memory().unwrap();

        let old_plugin = create_test_plugin("json", "JSON");
        let new_plugin = create_test_plugin("json-viewer", "JSON Viewer");
        db.save_plugin(&old_plugin).unwrap();
        db.save_plugin(&new_plugin).unwrap();

        db.index_features("json", &[create_test_feature("json")])
            .unwrap();
        db.index_features("json-viewer", &[create_test_feature("json")])
            .unwrap();

        let feature = db.get_feature("json").unwrap();
        assert_eq!(feature.plugin_id, "json-viewer");
        assert_eq!(feature.plugin_name, "JSON Viewer");

        let all = db.all_features().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].code, "json");
        assert_eq!(all[0].plugin_id, "json-viewer");
    }

    #[test]
    fn test_plugin_data_crud() {
        let db = Database::in_memory().unwrap();
        let plugin_id = "data-plugin";

        let plugin = create_test_plugin(plugin_id, "Data Plugin");
        db.save_plugin(&plugin).unwrap();

        // Create
        let doc1 = Document {
            id: "doc1".to_string(),
            rev: None,
            data: serde_json::json!({"name": "Alice", "age": 30}),
        };
        let doc2 = Document {
            id: "doc2".to_string(),
            rev: None,
            data: serde_json::json!({"name": "Bob", "age": 25}),
        };

        db.plugin_data_put(plugin_id, &doc1).unwrap();
        db.plugin_data_put(plugin_id, &doc2).unwrap();

        // Read single
        let retrieved = db.plugin_data_get(plugin_id, "doc1").unwrap().unwrap();
        assert_eq!(retrieved.data["name"], "Alice");

        // Read all
        let all = db.plugin_data_all(plugin_id).unwrap();
        assert_eq!(all.len(), 2);

        // Update
        let updated = Document {
            id: "doc1".to_string(),
            rev: None,
            data: serde_json::json!({"name": "Alice", "age": 31}),
        };
        db.plugin_data_put(plugin_id, &updated).unwrap();
        let re_retrieved = db.plugin_data_get(plugin_id, "doc1").unwrap().unwrap();
        assert_eq!(re_retrieved.data["age"], 31);

        // Delete
        db.plugin_data_remove(plugin_id, "doc1").unwrap();
        assert!(db.plugin_data_get(plugin_id, "doc1").unwrap().is_none());
        let remaining = db.plugin_data_all(plugin_id).unwrap();
        assert_eq!(remaining.len(), 1);
    }

    #[test]
    fn test_plugin_data_bulk_operations() {
        let db = Database::in_memory().unwrap();
        let plugin_id = "bulk-plugin";

        let plugin = create_test_plugin(plugin_id, "Bulk Plugin");
        db.save_plugin(&plugin).unwrap();

        let docs = vec![
            Document {
                id: "bulk1".to_string(),
                rev: None,
                data: serde_json::json!({"value": 1}),
            },
            Document {
                id: "bulk2".to_string(),
                rev: None,
                data: serde_json::json!({"value": 2}),
            },
            Document {
                id: "bulk3".to_string(),
                rev: None,
                data: serde_json::json!({"value": 3}),
            },
        ];

        db.plugin_data_bulk(plugin_id, &docs).unwrap();

        let all = db.plugin_data_all(plugin_id).unwrap();
        assert_eq!(all.len(), 3);

        for i in 1..=3 {
            let doc = db
                .plugin_data_get(plugin_id, &format!("bulk{}", i))
                .unwrap()
                .unwrap();
            assert_eq!(doc.data["value"], i);
        }
    }

    #[test]
    fn plugin_data_put_update_preserves_attachments() {
        let db = Database::in_memory().unwrap();
        let plugin_id = "put-attachment-plugin";
        db.save_plugin(&create_test_plugin(plugin_id, "Put Attachment Plugin"))
            .unwrap();
        db.plugin_data_put(
            plugin_id,
            &Document {
                id: "doc".to_string(),
                rev: None,
                data: serde_json::json!({"version": 1}),
            },
        )
        .unwrap();
        db.put_attachment(
            plugin_id,
            "doc",
            "payload.bin",
            b"single-put-attachment",
            "application/octet-stream",
        )
        .unwrap();

        db.plugin_data_put(
            plugin_id,
            &Document {
                id: "doc".to_string(),
                rev: None,
                data: serde_json::json!({"version": 2}),
            },
        )
        .unwrap();

        assert_eq!(
            db.plugin_data_get(plugin_id, "doc").unwrap().unwrap().data["version"],
            2
        );
        assert_eq!(
            db.get_attachment(plugin_id, "doc", "payload.bin")
                .unwrap()
                .unwrap()
                .0,
            b"single-put-attachment"
        );
    }

    #[test]
    fn plugin_data_bulk_update_preserves_attachments() {
        let db = Database::in_memory().unwrap();
        let plugin_id = "bulk-attachment-plugin";
        db.save_plugin(&create_test_plugin(plugin_id, "Bulk Attachment Plugin"))
            .unwrap();
        db.plugin_data_put(
            plugin_id,
            &Document {
                id: "doc".to_string(),
                rev: None,
                data: serde_json::json!({"version": 1}),
            },
        )
        .unwrap();
        db.put_attachment(
            plugin_id,
            "doc",
            "payload.bin",
            b"bulk-put-attachment",
            "application/octet-stream",
        )
        .unwrap();

        db.plugin_data_bulk(
            plugin_id,
            &[
                Document {
                    id: "doc".to_string(),
                    rev: None,
                    data: serde_json::json!({"version": 2}),
                },
                Document {
                    id: "new-doc".to_string(),
                    rev: None,
                    data: serde_json::json!({"created": true}),
                },
            ],
        )
        .unwrap();

        assert_eq!(
            db.plugin_data_get(plugin_id, "doc").unwrap().unwrap().data["version"],
            2
        );
        assert_eq!(
            db.get_attachment(plugin_id, "doc", "payload.bin")
                .unwrap()
                .unwrap()
                .0,
            b"bulk-put-attachment"
        );
    }

    #[test]
    fn test_settings_crud() {
        let db = Database::in_memory().unwrap();

        // Create
        db.set_setting("key1", "value1").unwrap();
        db.set_setting("key2", "value2").unwrap();

        // Read
        assert_eq!(db.get_setting("key1").unwrap(), Some("value1".to_string()));
        assert_eq!(db.get_setting("key2").unwrap(), Some("value2".to_string()));
        assert_eq!(db.get_setting("nonexistent").unwrap(), None);

        // Update
        db.set_setting("key1", "new_value1").unwrap();
        assert_eq!(
            db.get_setting("key1").unwrap(),
            Some("new_value1".to_string())
        );

        // Delete
        assert!(db.delete_setting("key1").unwrap());
        assert_eq!(db.get_setting("key1").unwrap(), None);
        assert!(!db.delete_setting("nonexistent").unwrap());
    }

    #[test]
    fn test_delete_audit_entries_for_client_only_removes_matching_client() {
        let db = Database::in_memory().unwrap();

        db.insert_audit_entry(&AuditLogEntry::new(
            "desktop-smoke",
            "find_local_files",
            serde_json::json!({"dry_run": true}),
            AuditStatus::Denied,
        ))
        .unwrap();
        db.insert_audit_entry(&AuditLogEntry::new(
            "user-client",
            "search_clipboard",
            serde_json::json!({"query": "invoice"}),
            AuditStatus::Allowed,
        ))
        .unwrap();

        assert_eq!(
            db.delete_audit_entries_for_client("desktop-smoke").unwrap(),
            1
        );

        let remaining = db.list_audit_entries(10).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].client_id, "user-client");
        assert_eq!(remaining[0].tool_name, "search_clipboard");
        assert_eq!(
            db.delete_audit_entries_for_client("missing-client")
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_prune_audit_entries_applies_age_and_count_retention() {
        let db = Database::in_memory().unwrap();

        let entries = [
            ("old", "2026-05-01T00:00:00Z"),
            ("middle", "2026-06-01T00:00:00Z"),
            ("newer", "2026-06-03T00:00:00Z"),
            ("newest", "2026-06-04T00:00:00Z"),
        ];
        for (id, timestamp) in entries {
            let mut entry = AuditLogEntry::new(
                "codex",
                "find_local_files",
                serde_json::json!({ "id": id }),
                AuditStatus::Allowed,
            );
            entry.id = format!("audit-{id}");
            entry.timestamp = timestamp.to_string();
            db.insert_audit_entry(&entry).unwrap();
        }

        let deleted = db
            .prune_audit_entries(Some("2026-06-01T00:00:00Z"), Some(2))
            .unwrap();
        assert_eq!(deleted, 2);

        let remaining = db.list_audit_entries(10).unwrap();
        assert_eq!(
            remaining
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["audit-newest", "audit-newer"]
        );

        assert_eq!(
            db.prune_audit_entries(Some("2026-06-01T00:00:00Z"), Some(2))
                .unwrap(),
            0
        );
    }

    #[test]
    fn test_audit_log_filter_indexes_exist() {
        let db = Database::in_memory().unwrap();
        let conn = db.conn.lock();
        let mut stmt = conn
            .prepare("PRAGMA index_list(audit_log)")
            .expect("index list");
        let indexes = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query indexes")
            .collect::<std::result::Result<Vec<_>, _>>()
            .expect("indexes");

        assert!(indexes.contains(&"idx_audit_log_status_timestamp".to_string()));
        assert!(indexes.contains(&"idx_audit_log_tool_timestamp".to_string()));
        assert!(indexes.contains(&"idx_audit_log_client_timestamp".to_string()));
    }

    #[test]
    fn test_clipboard_history_record_search_and_prune() {
        let db = Database::in_memory().unwrap();

        let first = db
            .record_clipboard_text("Invoice API key copied", "2026-06-01T10:00:00Z")
            .unwrap();
        let duplicate = db
            .record_clipboard_text("Invoice API key copied", "2026-06-01T10:05:00Z")
            .unwrap();
        db.record_clipboard_text("Build error log", "2026-06-02T10:00:00Z")
            .unwrap();

        assert_eq!(first.id, duplicate.id);
        assert_eq!(duplicate.used_count, 2);
        assert_eq!(duplicate.last_copied_at, "2026-06-01T10:05:00Z");

        let matches = db.search_clipboard_history("api", 10).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].text, "Invoice API key copied");
        assert_eq!(matches[0].used_count, 2);

        let recent = db.search_clipboard_history("", 10).unwrap();
        assert_eq!(
            recent
                .iter()
                .map(|entry| entry.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Build error log", "Invoice API key copied"]
        );

        let removed = db.prune_clipboard_history("2026-06-02T00:00:00Z").unwrap();
        assert_eq!(removed, 1);
        let remaining = db.search_clipboard_history("", 10).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].text, "Build error log");

        let exported = db.export_clipboard_history_json(10).unwrap();
        let exported_json: serde_json::Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(exported_json["count"], 1);
        assert_eq!(exported_json["entries"][0]["text"], "Build error log");

        assert_eq!(db.clear_clipboard_history().unwrap(), 1);
        assert!(db.search_clipboard_history("", 10).unwrap().is_empty());
    }

    #[test]
    fn test_attachment_operations() {
        let db = Database::in_memory().unwrap();
        let plugin_id = "attach-plugin";

        let plugin = create_test_plugin(plugin_id, "Attach Plugin");
        db.save_plugin(&plugin).unwrap();

        let doc = Document {
            id: "doc1".to_string(),
            rev: None,
            data: serde_json::json!({"type": "document"}),
        };
        db.plugin_data_put(plugin_id, &doc).unwrap();

        // Create
        let data = b"image binary data";
        db.put_attachment(plugin_id, "doc1", "image.png", data, "image/png")
            .unwrap();

        // Read
        let (retrieved_data, content_type) = db
            .get_attachment(plugin_id, "doc1", "image.png")
            .unwrap()
            .unwrap();
        assert_eq!(retrieved_data, data);
        assert_eq!(content_type, "image/png");

        // Update
        let new_data = b"updated binary data";
        db.put_attachment(plugin_id, "doc1", "image.png", new_data, "image/png")
            .unwrap();
        let (re_retrieved, _) = db
            .get_attachment(plugin_id, "doc1", "image.png")
            .unwrap()
            .unwrap();
        assert_eq!(re_retrieved, new_data);

        // Delete
        assert!(db
            .delete_attachment(plugin_id, "doc1", "image.png")
            .unwrap());
        assert!(db
            .get_attachment(plugin_id, "doc1", "image.png")
            .unwrap()
            .is_none());
        assert!(!db
            .delete_attachment(plugin_id, "doc1", "nonexistent.png")
            .unwrap());
    }

    #[test]
    fn test_cascade_delete() {
        let db = Database::in_memory().unwrap();
        let plugin_id = "cascade-plugin";

        let plugin = create_test_plugin(plugin_id, "Cascade Plugin");
        db.save_plugin(&plugin).unwrap();

        // Add features
        db.index_features(plugin_id, &[create_test_feature("feat1")])
            .unwrap();

        // Add documents
        let doc = Document {
            id: "doc1".to_string(),
            rev: None,
            data: serde_json::json!({"data": "test"}),
        };
        db.plugin_data_put(plugin_id, &doc).unwrap();

        // Add attachment
        db.put_attachment(plugin_id, "doc1", "file.txt", b"data", "text/plain")
            .unwrap();

        // Delete plugin should cascade
        db.delete_plugin(plugin_id).unwrap();

        assert!(db.get_plugin(plugin_id).is_err());
        assert!(db.get_feature("feat1").is_err());
        assert!(db.plugin_data_get(plugin_id, "doc1").unwrap().is_none());
        assert!(db
            .get_attachment(plugin_id, "doc1", "file.txt")
            .unwrap()
            .is_none());
    }
}
