use std::{collections::BTreeMap, path::PathBuf};

use async_trait::async_trait;
use atools_core::{
    db::Database,
    pasteboard::{
        HybridLogicalClock, PasteboardEntityType, PasteboardItem, PasteboardItemKind,
        PasteboardPayload, PasteboardSourceApp, PasteboardTombstone, Pinboard,
    },
};
use atools_lib::pasteboard_sync::{
    derive_vault_key, ensure_vault_metadata, sync_pasteboard_vault, PasteboardWebDavRequest,
    PasteboardWebDavResponse, PasteboardWebDavTransport,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::{header::ETAG, Method, Url};
use serde::Deserialize;
use serde_json::json;

const ITEM_ID: &str = "fixture-item";
const PINBOARD_ID: &str = "fixture-board";
const INITIAL_TIME: &str = "2026-07-17T00:00:00.000Z";
const RUST_EDIT_TIME: &str = "2026-07-17T00:01:00.000Z";
const DELETE_TIME: &str = "2026-07-17T00:03:00.000Z";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureConfig {
    server_url: String,
    username: String,
    password: String,
    sync_password: String,
    db_path: PathBuf,
    blob_root: PathBuf,
}

struct FixtureTransport {
    client: reqwest::Client,
    base_url: Url,
    username: String,
    password: String,
}

impl FixtureTransport {
    fn new(config: &FixtureConfig) -> Result<Self, String> {
        let mut base_url = Url::parse(&config.server_url)
            .map_err(|error| format!("Invalid fixture URL: {error}"))?;
        if base_url.scheme() != "http" || base_url.host_str() != Some("127.0.0.1") {
            return Err("Cross-host fixture transport only accepts loopback HTTP".to_string());
        }
        if !base_url.path().ends_with('/') {
            base_url.set_path(&format!("{}/", base_url.path()));
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| format!("Failed to build fixture client: {error}"))?,
            base_url,
            username: config.username.clone(),
            password: config.password.clone(),
        })
    }
}

#[async_trait]
impl PasteboardWebDavTransport for FixtureTransport {
    async fn request(
        &self,
        request: PasteboardWebDavRequest,
    ) -> Result<PasteboardWebDavResponse, String> {
        let url = self
            .base_url
            .join(&request.path)
            .map_err(|error| format!("Invalid fixture request path: {error}"))?;
        if url.origin() != self.base_url.origin() || !url.path().starts_with(self.base_url.path()) {
            return Err("Fixture request escaped the configured vault".to_string());
        }
        let method = Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "Fixture request method is invalid".to_string())?;
        let mut builder = self
            .client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password));
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| format!("Fixture request failed: {error}"))?;
        let status = response.status().as_u16();
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read fixture response: {error}"))?
            .to_vec();
        Ok(PasteboardWebDavResponse { status, etag, body })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let action = arguments.next().ok_or("Missing fixture action")?;
    let config_path = arguments.next().ok_or("Missing fixture config path")?;
    if arguments.next().is_some() {
        return Err("Unexpected fixture arguments".into());
    }
    let config: FixtureConfig = serde_json::from_slice(&std::fs::read(config_path)?)?;
    std::fs::create_dir_all(&config.blob_root)?;
    if let Some(parent) = config.db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let db = Database::open(&config.db_path)?;

    let result = match action.as_str() {
        "seed-sync" => {
            seed(&db)?;
            sync(&db, &config).await?
        }
        "sync" => sync(&db, &config).await?,
        "mutate-title" => {
            mutate_title(&db)?;
            json!({ "status": "mutated", "field": "title" })
        }
        "delete-item" => {
            delete_item(&db)?;
            json!({ "status": "deleted", "id": ITEM_ID })
        }
        "inspect" => inspect(&db)?,
        other => return Err(format!("Unsupported fixture action: {other}").into()),
    };
    println!(
        "PASTEBOARDPRO_FIXTURE_JSON={}",
        serde_json::to_string(&result)?
    );
    Ok(())
}

async fn sync(db: &Database, config: &FixtureConfig) -> Result<serde_json::Value, String> {
    let transport = FixtureTransport::new(config)?;
    let metadata = ensure_vault_metadata(&transport).await?;
    let salt = BASE64
        .decode(metadata.kdf.salt.as_bytes())
        .map_err(|_| "Fixture vault salt is not valid base64".to_string())?;
    let key = derive_vault_key(&config.sync_password, &salt)?;
    let result = sync_pasteboard_vault(db, &config.blob_root, &transport, &key).await?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

fn seed(db: &Database) -> Result<(), Box<dyn std::error::Error>> {
    if db.get_pinboard(PINBOARD_ID)?.is_none() {
        let clocks = field_clocks(&["name", "color", "orderKey"], 1_000, "rust-seed");
        db.upsert_pinboard(&Pinboard {
            id: PINBOARD_ID.to_string(),
            name: "Fixture Inbox".to_string(),
            color: "#8B5CF6".to_string(),
            order_key: "a0".to_string(),
            created_at: INITIAL_TIME.to_string(),
            updated_at: INITIAL_TIME.to_string(),
            field_clocks: clocks,
        })?;
    }
    if db.get_pasteboard_item(ITEM_ID)?.is_none() {
        let clocks = field_clocks(
            &[
                "title",
                "payload",
                "ocrText",
                "pinboardId",
                "pinboardOrderKey",
                "pinned",
            ],
            1_000,
            "rust-seed",
        );
        db.upsert_pasteboard_item(&PasteboardItem {
            id: ITEM_ID.to_string(),
            kind: PasteboardItemKind::Text,
            title: Some("Original secret title".to_string()),
            source_app: Some(PasteboardSourceApp {
                bundle_id: Some("com.example.fixture".to_string()),
                name: Some("Fixture Source".to_string()),
            }),
            source_device_id: "rust-seed".to_string(),
            copied_at: INITIAL_TIME.to_string(),
            updated_at: INITIAL_TIME.to_string(),
            content_fingerprint: "fixture-fingerprint".to_string(),
            payload: PasteboardPayload {
                revision: "payload-fixture-v1".to_string(),
                text: Some("TOP SECRET cross host body".to_string()),
                html: None,
                blob_id: None,
                media_type: Some("text/plain".to_string()),
                file_paths: Some(vec!["/Users/fixture/Confidential Plan.txt".to_string()]),
            },
            ocr_text: Some("CONFIDENTIAL OCR invoice 424242".to_string()),
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: clocks,
        })?;
    }
    Ok(())
}

fn mutate_title(db: &Database) -> Result<(), Box<dyn std::error::Error>> {
    let mut item = db
        .get_pasteboard_item(ITEM_ID)?
        .ok_or("Fixture item is missing before title mutation")?;
    item.title = Some("Rust concurrent title".to_string());
    item.updated_at = RUST_EDIT_TIME.to_string();
    item.field_clocks
        .insert("title".to_string(), clock(3_000, "rust-title"));
    db.upsert_pasteboard_item(&item)?;
    Ok(())
}

fn delete_item(db: &Database) -> Result<(), Box<dyn std::error::Error>> {
    db.upsert_pasteboard_tombstone(&PasteboardTombstone {
        id: ITEM_ID.to_string(),
        entity_type: PasteboardEntityType::PasteItem,
        deleted: true,
        deleted_at: DELETE_TIME.to_string(),
        source_device_id: "rust-delete".to_string(),
        clock: clock(5_000, "rust-delete"),
    })?;
    Ok(())
}

fn inspect(db: &Database) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    Ok(json!({
        "items": db.list_pasteboard_items_for_sync()?,
        "pinboards": db.list_pinboards()?,
        "tombstones": db.list_pasteboard_tombstones()?,
    }))
}

fn field_clocks(
    fields: &[&str],
    wall_ms: i64,
    device_id: &str,
) -> BTreeMap<String, HybridLogicalClock> {
    fields
        .iter()
        .map(|field| ((*field).to_string(), clock(wall_ms, device_id)))
        .collect()
}

fn clock(wall_ms: i64, device_id: &str) -> HybridLogicalClock {
    HybridLogicalClock {
        wall_ms,
        counter: 0,
        device_id: device_id.to_string(),
    }
}
