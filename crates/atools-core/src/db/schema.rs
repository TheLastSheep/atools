use super::{feature_label_schema, plugin_data_attachments, plugin_dynamic_features, Database};
use crate::error::Result;

impl Database {
    pub(super) fn run_migrations(&self) -> Result<()> {
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

            CREATE TABLE IF NOT EXISTS plugin_web_storage (
                plugin_id TEXT NOT NULL,
                key BLOB NOT NULL,
                value BLOB NOT NULL,
                PRIMARY KEY (plugin_id, key),
                FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
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

            CREATE TABLE IF NOT EXISTS pasteboard_pinboards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                order_key TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                field_clocks TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS pasteboard_items (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                title TEXT,
                source_app TEXT,
                source_device_id TEXT NOT NULL,
                copied_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                content_fingerprint TEXT NOT NULL,
                payload TEXT NOT NULL,
                ocr_text TEXT,
                pinboard_id TEXT,
                pinboard_order_key TEXT,
                pinned BOOLEAN NOT NULL DEFAULT 0,
                field_clocks TEXT NOT NULL DEFAULT '{}',
                search_text TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (pinboard_id) REFERENCES pasteboard_pinboards(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS plugin_clipboard_history_media (
                id TEXT PRIMARY KEY,
                item_id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL CHECK(kind IN ('image', 'file')),
                copied_at TEXT NOT NULL,
                preview TEXT NOT NULL,
                payload TEXT NOT NULL,
                search_text TEXT NOT NULL,
                FOREIGN KEY (item_id) REFERENCES pasteboard_items(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pasteboard_blobs (
                id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL UNIQUE,
                relative_path TEXT NOT NULL UNIQUE,
                media_type TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                last_accessed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pasteboard_item_blobs (
                item_id TEXT NOT NULL,
                blob_id TEXT NOT NULL,
                PRIMARY KEY (item_id, blob_id),
                FOREIGN KEY (item_id) REFERENCES pasteboard_items(id) ON DELETE CASCADE,
                FOREIGN KEY (blob_id) REFERENCES pasteboard_blobs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS pasteboard_tombstones (
                entity_id TEXT PRIMARY KEY,
                entity_kind TEXT NOT NULL,
                deleted_at TEXT NOT NULL,
                deleted_clock TEXT NOT NULL DEFAULT '{}',
                source_device_id TEXT NOT NULL
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
            CREATE INDEX IF NOT EXISTS idx_pasteboard_items_copied_at ON pasteboard_items(copied_at DESC);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_items_updated_at ON pasteboard_items(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_items_kind_copied_at ON pasteboard_items(kind, copied_at DESC);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_items_pinboard_order ON pasteboard_items(pinboard_id, pinboard_order_key);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_items_fingerprint ON pasteboard_items(content_fingerprint);
            CREATE INDEX IF NOT EXISTS idx_plugin_clipboard_history_media_copied_at
                ON plugin_clipboard_history_media(copied_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_plugin_clipboard_history_media_kind_copied_at
                ON plugin_clipboard_history_media(kind, copied_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_pinboards_order ON pasteboard_pinboards(order_key);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_item_blobs_blob ON pasteboard_item_blobs(blob_id);
            CREATE INDEX IF NOT EXISTS idx_pasteboard_tombstones_deleted_at ON pasteboard_tombstones(deleted_at);
            "#,
        )?;
        super::memory::ensure_memory_scope_columns(&conn)?;
        plugin_data_attachments::migrate_attachment_metadata(&conn)?;
        feature_label_schema::migrate(&conn)?;
        plugin_dynamic_features::migrate(&conn)?;
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
}
