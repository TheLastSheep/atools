//! One session-bound handler shared by actual WebView events and the Rust fixture.
use super::*;

pub(super) struct DropBinding {
    app: AppHandle<Wry>,
    runtime: Weak<SettingsViewRuntime>,
    identity: ChildIdentity,
    revisions: Arc<AtomicU64>,
    drop_flight: Arc<AtomicBool>,
    hover_active: AtomicBool,
    #[cfg(feature = "legacy-node-smoke")]
    pub(super) binding_nonce: String,
}

impl DropBinding {
    pub(super) fn handle_event(&self, event: &DragDropEvent) -> Option<DropDispatch> {
        if let Some(phase) = hover_notice_for_event(&self.hover_active, event) {
            send_notice(
                &self.app,
                &self.runtime,
                &self.identity,
                &self.revisions,
                phase,
                DropCounts::default(),
                false,
                false,
            );
        }
        match event {
            DragDropEvent::Drop { paths, .. } => Some(receive_drop(
                &self.app,
                &self.runtime,
                &self.identity,
                &self.revisions,
                &self.drop_flight,
                paths,
            )),
            _ => None,
        }
    }

    #[cfg(feature = "legacy-node-smoke")]
    pub(super) fn identity(&self) -> &ChildIdentity {
        &self.identity
    }

    #[cfg(feature = "legacy-node-smoke")]
    pub(super) fn is_current(&self) -> bool {
        current_target(&self.app, &self.runtime, &self.identity).is_some()
    }
}

pub(in crate::renderer_settings_view) fn bind_child(
    app: &AppHandle<Wry>,
    session: &SessionView,
    child: &Webview<Wry>,
) -> Result<(), String> {
    if child.label() != session.label || child.window().label() != "main" {
        return Err("Settings local-drop child identity is invalid".into());
    }
    let binding = Arc::new(DropBinding {
        app: app.clone(),
        runtime: Arc::downgrade(&super::super::runtime(app)?),
        identity: ChildIdentity {
            session_id: session.id.clone(),
            label: session.label.clone(),
            bundle_revision: session.bundle_revision.clone(),
        },
        revisions: Arc::new(AtomicU64::new(0)),
        drop_flight: Arc::new(AtomicBool::new(false)),
        hover_active: AtomicBool::new(false),
        #[cfg(feature = "legacy-node-smoke")]
        binding_nonce: uuid::Uuid::new_v4().simple().to_string(),
    });
    #[cfg(feature = "legacy-node-smoke")]
    super::fixture::register_binding(app, &binding)?;
    child.on_webview_event(move |event| {
        if let WebviewEvent::DragDrop(event) = event {
            let _ = binding.handle_event(event);
        }
    });
    Ok(())
}
