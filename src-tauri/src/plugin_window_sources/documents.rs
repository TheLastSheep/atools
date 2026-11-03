//! In-memory HTML documents served only to the native renderer that owns them.
use super::{identity::validate_renderer_label, registry::Registry, SourceBinding};
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};

pub(super) const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_LIVE_DOCUMENT_BYTES: usize = 16 * 1024 * 1024;

pub(crate) struct WindowDocument {
    pub(crate) id: String,
    pub(crate) generation: u64,
    pub(crate) relative_path: PathBuf,
    /// The bytes live only as part of the document pin. Queued responders must
    /// hold `Arc<WindowDocument>`; there is no detached body Arc that could
    /// outlive the weak-ledger entry and escape the aggregate budget.
    pub(crate) body: String,
}

pub(super) fn validate_relative_html_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > 4096
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(['\\', ':', '?', '#'])
        || path.chars().any(char::is_control)
        || Path::new(path).is_absolute()
    {
        return Err("Invalid plugin window document path".into());
    }

    let mut normalized = PathBuf::new();
    let mut segments = 0;
    for segment in path.split('/') {
        segments += 1;
        if segments > 32
            || segment.is_empty()
            || segment.len() > 1024
            || segment == "."
            || segment == ".."
        {
            return Err("Invalid plugin window document path".into());
        }
        let mut components = Path::new(segment).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err("Invalid plugin window document path".into());
        }
        let lower = segment.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or_default();
        if lower.starts_with('.')
            || [
                "credential",
                "credentials",
                "secret",
                "secrets",
                "token",
                "tokens",
                "id_rsa",
                "id_ed25519",
            ]
            .contains(&stem)
        {
            return Err("Invalid plugin window document path".into());
        }
        normalized.push(segment);
    }

    let extension = normalized
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.rsplit_once('.').map(|(_, extension)| extension))
        .unwrap_or_default();
    if !matches!(extension.to_ascii_lowercase().as_str(), "html" | "htm") {
        return Err("Plugin window document must be an HTML file".into());
    }
    Ok(normalized)
}

pub(super) fn prepare(
    registry: &mut Registry,
    binding: &SourceBinding,
    renderer: &str,
    generation: u64,
    relative_path: &str,
    html: String,
) -> Result<String, String> {
    validate_renderer_label(renderer)?;
    if renderer == binding.owner().window {
        return Err("Native renderer must have its own window label".into());
    }
    super::identity::validate_generation(generation)?;
    let relative_path = validate_relative_html_path(relative_path)?;
    if html.len() > MAX_DOCUMENT_BYTES {
        return Err("Plugin window document exceeds the 4 MiB limit".into());
    }

    {
        let grant = registry
            .renderers
            .get(renderer)
            .ok_or("Native renderer has no source authorization")?;
        if !grant.matches_binding(binding) || !grant.is_active() {
            return Err("Native renderer source authorization is no longer current".into());
        }
        if let Some(current) = grant.document() {
            if generation < current.generation {
                return Err("Plugin window document generation is stale".into());
            }
            if generation == current.generation {
                if current.relative_path == relative_path
                    && current.body.as_bytes() == html.as_bytes()
                {
                    return Ok(current.id.clone());
                }
                return Err("Plugin window document changed without a new generation".into());
            }
        }
    }

    let current_bytes = retained_bytes_after_replacement(registry, renderer);
    if current_bytes.saturating_add(html.len()) > MAX_LIVE_DOCUMENT_BYTES {
        return Err("Active plugin window documents exceed the 16 MiB limit".into());
    }
    let id = unique_document_id(registry);
    let document = Arc::new(WindowDocument {
        id: id.clone(),
        generation,
        relative_path,
        body: html,
    });
    registry.document_refs.push(Arc::downgrade(&document));

    // A fresh grant invalidates every response queued under the prior document.
    let grant = registry
        .renderers
        .get(renderer)
        .expect("renderer checked above");
    let replacement = grant.with_document(document);
    grant.deactivate();
    registry.renderers.insert(renderer.to_owned(), replacement);
    Ok(id)
}

fn retained_bytes_after_replacement(registry: &mut Registry, renderer: &str) -> usize {
    registry
        .document_refs
        .retain(|document| document.strong_count() > 0);
    let mut total = 0usize;
    for reference in &registry.document_refs {
        let Some(document) = reference.upgrade() else {
            continue;
        };
        let active_label = registry.renderers.iter().find_map(|(label, grant)| {
            grant
                .document()
                .filter(|current| Arc::ptr_eq(current, &document))
                .map(|_| label.as_str())
        });
        match active_label {
            Some(label) if label != renderer => total = total.saturating_add(document.body.len()),
            Some(_) if Arc::strong_count(&document) > 2 => {
                // The registry and this temporary upgrade own two references. Any
                // additional reference is a response still queued for this body.
                total = total.saturating_add(document.body.len());
            }
            None if Arc::strong_count(&document) > 1 => {
                // Retired documents remain charged while an in-flight request pins them.
                total = total.saturating_add(document.body.len());
            }
            _ => {}
        }
    }
    total
}

fn unique_document_id(registry: &Registry) -> String {
    loop {
        let id = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let in_use = registry
            .document_refs
            .iter()
            .filter_map(|reference| reference.upgrade())
            .any(|document| document.id == id);
        if !in_use {
            return id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_asset_protocol::{Authorization, Owner};
    use std::path::PathBuf;

    fn owner() -> Owner {
        Owner::new("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff").unwrap()
    }

    fn binding(owner: Owner, frame: &str, generation: u64) -> SourceBinding {
        SourceBinding::new(
            owner,
            "session-a".into(),
            Authorization {
                root: PathBuf::from("/tmp/window-document"),
                revision: Some("rev-a".into()),
            },
            frame.into(),
            generation,
            format!("{generation:032x}"),
        )
    }

    fn authorized(registry: &mut Registry, frame: &str, renderer: &str) -> SourceBinding {
        let source = binding(owner(), frame, 1);
        registry.bind(source.clone()).unwrap();
        registry.add_renderer(renderer, &source).unwrap();
        source
    }

    #[test]
    fn validates_only_package_relative_html_paths() {
        for path in [
            "",
            "/page.html",
            "C:/page.html",
            "a/../page.html",
            "a//page.html",
            "a\\page.html",
            "a/page.js",
            "a/page.html?x=1",
        ] {
            assert!(validate_relative_html_path(path).is_err(), "{path}");
        }
        assert_eq!(
            validate_relative_html_path("pages/index.HTML").unwrap(),
            PathBuf::from("pages/index.HTML")
        );
    }

    #[test]
    fn document_generation_is_monotonic_and_replacement_revokes_old_grants() {
        let mut registry = Registry::default();
        let source = authorized(&mut registry, "main", "native-one");
        let id = prepare(
            &mut registry,
            &source,
            "native-one",
            1,
            "pages/index.html",
            "one".into(),
        )
        .unwrap();
        assert_eq!(id.len(), 64);
        assert_eq!(
            prepare(
                &mut registry,
                &source,
                "native-one",
                1,
                "pages/index.html",
                "one".into()
            )
            .unwrap(),
            id
        );
        assert!(prepare(
            &mut registry,
            &source,
            "native-one",
            1,
            "pages/index.html",
            "different".into()
        )
        .is_err());
        assert!(prepare(
            &mut registry,
            &source,
            "native-one",
            1,
            "other.html",
            "one".into()
        )
        .is_err());
        assert!(prepare(
            &mut registry,
            &source,
            "native-one",
            0,
            "pages/index.html",
            "one".into()
        )
        .is_err());

        let old = registry.renderers.get("native-one").unwrap().permit();
        let next = prepare(
            &mut registry,
            &source,
            "native-one",
            2,
            "pages/index.html",
            "two".into(),
        )
        .unwrap();
        assert_ne!(next, id);
        assert!(!old.is_active());
        assert!(registry.renderers.get("native-one").unwrap().is_active());
    }

    #[test]
    fn documents_require_the_existing_exact_renderer_source_and_fit_both_limits() {
        let mut registry = Registry::default();
        let source = authorized(&mut registry, "main", "native-one");
        let other = binding(owner(), "child:other", 1);
        assert!(prepare(
            &mut registry,
            &other,
            "native-one",
            1,
            "index.html",
            "body".into()
        )
        .is_err());
        assert!(prepare(
            &mut registry,
            &source,
            "unregistered",
            1,
            "index.html",
            "body".into()
        )
        .is_err());
        assert!(prepare(
            &mut registry,
            &source,
            "native-one",
            1,
            "index.html",
            "x".repeat(MAX_DOCUMENT_BYTES + 1)
        )
        .is_err());

        let mut ids = Vec::new();
        for index in 0..4 {
            let renderer = format!("native-{index}");
            let binding = authorized(&mut registry, &format!("child:{index}"), &renderer);
            ids.push(
                prepare(
                    &mut registry,
                    &binding,
                    &renderer,
                    1,
                    "index.html",
                    "x".repeat(MAX_DOCUMENT_BYTES),
                )
                .unwrap(),
            );
        }
        let overflow = authorized(&mut registry, "child:overflow", "native-overflow");
        assert!(prepare(
            &mut registry,
            &overflow,
            "native-overflow",
            1,
            "index.html",
            "x".into()
        )
        .is_err());
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn resolved_queued_document_stays_charged_until_final_handoff_releases_it() {
        let mut registry = Registry::default();
        let source = authorized(&mut registry, "child:one", "native-one");
        let body = "x".repeat(MAX_DOCUMENT_BYTES);
        let id = prepare(
            &mut registry,
            &source,
            "native-one",
            1,
            "index.html",
            body.clone(),
        )
        .unwrap();
        // This is the same resolved value the asset protocol moves into the
        // queued responder: its document Arc survives independently of the
        // temporary grant clone and keeps the whole body charged.
        let grant = registry.renderers.get("native-one").unwrap().clone();
        let (_lease, permit, pinned) =
            super::super::renderer::document_access_from_authorized_grant(
                crate::plugin_asset_protocol::Lease {
                    id: source.resource_session_id().into(),
                    owner: source.owner().clone(),
                    authorization: source.authorization().clone(),
                },
                grant,
                &id,
                Path::new("index.html"),
            )
            .unwrap();
        assert_eq!(pinned.body.len(), MAX_DOCUMENT_BYTES);
        prepare(
            &mut registry,
            &source,
            "native-one",
            2,
            "index.html",
            body.clone(),
        )
        .unwrap();
        assert!(!permit.is_active());
        for index in 0..2 {
            let renderer = format!("native-other-{index}");
            let other = authorized(&mut registry, &format!("child:other-{index}"), &renderer);
            prepare(
                &mut registry,
                &other,
                &renderer,
                1,
                "index.html",
                body.clone(),
            )
            .unwrap();
        }
        let fifth = authorized(&mut registry, "child:last", "native-last");
        assert!(prepare(
            &mut registry,
            &fifth,
            "native-last",
            1,
            "index.html",
            "x".into()
        )
        .is_err());
        drop(pinned);
        assert!(prepare(
            &mut registry,
            &fifth,
            "native-last",
            1,
            "index.html",
            "x".into()
        )
        .is_ok());
    }
}
