use tauri::{
    http::{Request, StatusCode},
    AppHandle, Manager, Wry,
};
use url::Url;

use super::{identity, lifecycle, session::SessionView};

/// Authorize the app-icon protocol only for the currently active original
/// settings child. The caller still performs GET, opaque-ID, and catalog
/// membership checks before resolving any icon bytes.
pub(crate) fn authorize_app_icon_child_request(
    app: &AppHandle<Wry>,
    webview_label: &str,
    request: &Request<Vec<u8>>,
) -> Result<Option<String>, StatusCode> {
    let runtime = super::runtime(app).map_err(|_| StatusCode::FORBIDDEN)?;
    let session = runtime
        .current_for_label(webview_label)
        .map_err(|_| StatusCode::FORBIDDEN)?;
    let webview = app
        .get_webview(webview_label)
        .ok_or(StatusCode::FORBIDDEN)?;
    if webview.label() != session.label || webview.window().label() != "main" {
        return Err(StatusCode::FORBIDDEN);
    }
    let page_url = webview.url().map_err(|_| StatusCode::FORBIDDEN)?;
    authorize_settings_identity(&session, webview_label, &page_url, request)
}

fn authorize_settings_identity(
    session: &SessionView,
    webview_label: &str,
    page_url: &Url,
    request: &Request<Vec<u8>>,
) -> Result<Option<String>, StatusCode> {
    authorize_settings_binding(
        webview_label,
        &session.label,
        &session.id,
        &session.origin,
        page_url,
        &session.bundle_revision,
        session.bundle.revision(),
        lifecycle::session_can_serve(session),
        request,
    )
}

#[allow(clippy::too_many_arguments)]
fn authorize_settings_binding(
    webview_label: &str,
    active_label: &str,
    session_id: &str,
    session_origin: &str,
    page_url: &Url,
    session_bundle_revision: &str,
    active_bundle_revision: &str,
    session_can_serve: bool,
    request: &Request<Vec<u8>>,
) -> Result<Option<String>, StatusCode> {
    if webview_label != active_label
        || !session_can_serve
        || !identity::is_expected_settings_url(page_url, session_id)
        || session_bundle_revision.is_empty()
        || active_bundle_revision != session_bundle_revision
        || !identity::is_expected_origin(session_origin, session_id)
        || origin_for_settings_url(page_url, session_id).as_deref() != Some(session_origin)
    {
        return Err(StatusCode::FORBIDDEN);
    }

    authorize_child_origin_headers(session_origin, session_id, request)
}

fn authorize_child_origin_headers(
    expected_origin: &str,
    session_id: &str,
    request: &Request<Vec<u8>>,
) -> Result<Option<String>, StatusCode> {
    let mut origin_present = false;
    if let Some(origin) = request.headers().get("origin") {
        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        if origin != expected_origin {
            return Err(StatusCode::FORBIDDEN);
        }
        origin_present = true;
    }

    if let Some(referer) = request.headers().get("referer") {
        let referer = referer.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        let referer_url = Url::parse(referer).map_err(|_| StatusCode::FORBIDDEN)?;
        if origin_for_settings_url(&referer_url, session_id).as_deref() != Some(expected_origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    Ok(origin_present.then(|| expected_origin.to_owned()))
}

fn origin_for_settings_url(url: &Url, session_id: &str) -> Option<String> {
    if !identity::is_valid_session_id(session_id)
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_some()
        || url.scheme() != super::SETTINGS_SCHEME
        || url.host_str() != Some(format!("{session_id}.localhost").as_str())
    {
        return None;
    }
    Some(format!("{}://{}", url.scheme(), url.host_str()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111111141118111111111111111";
    const ORIGIN: &str = "atools-settings://11111111111141118111111111111111.localhost";
    const REVISION: &str = "bundle-revision-1";

    fn url(route: &str) -> Url {
        Url::parse(&format!("{ORIGIN}/index.html#{route}")).unwrap()
    }

    fn request(origin: Option<&str>, referer: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder();
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        if let Some(referer) = referer {
            builder = builder.header("referer", referer);
        }
        builder.body(Vec::new()).unwrap()
    }

    fn authorize(
        webview_label: &str,
        active_label: &str,
        page_url: &Url,
        active_bundle_revision: &str,
        session_can_serve: bool,
        request: &Request<Vec<u8>>,
    ) -> Result<Option<String>, StatusCode> {
        authorize_settings_binding(
            webview_label,
            active_label,
            ID,
            ORIGIN,
            page_url,
            REVISION,
            active_bundle_revision,
            session_can_serve,
            request,
        )
    }

    #[test]
    fn authorizes_only_current_original_settings_routes_and_origin() {
        let label = format!("ztools-settings-{ID}");
        for route in ["/generalSetting", "/allCommands", "/shortcuts"] {
            assert_eq!(
                authorize(
                    &label,
                    &label,
                    &url(route),
                    REVISION,
                    true,
                    &request(Some(ORIGIN), None),
                ),
                Ok(Some(ORIGIN.to_owned())),
                "expected route {route} to be authorized"
            );
        }
    }

    #[test]
    fn accepts_only_the_original_shortcuts_timestamp_fragment_query() {
        const TIMESTAMP: &str = "1793144658628";
        let label = format!("ztools-settings-{ID}");
        assert_eq!(
            authorize(
                &label,
                &label,
                &url(&format!("/shortcuts?_t={TIMESTAMP}")),
                REVISION,
                true,
                &request(Some(ORIGIN), None),
            ),
            Ok(Some(ORIGIN.to_owned())),
        );

        for fragment in [
            "/unknown?_t=1793144658628",
            "/shortcuts?_t=1793144658628&other=1",
            "/shortcuts?_t=1793144658628&_t=1793144658629",
            "/shortcuts?_t=",
            "/shortcuts?_t=179314465862x",
            "/shortcuts?_t=10000000000000000",
            "/shortcuts?_t=%31",
            "/%73hortcuts?_t=1793144658628",
            "/allCommands?_t=1793144658628",
            "/generalSetting?_t=1793144658628",
        ] {
            assert_eq!(
                authorize(
                    &label,
                    &label,
                    &url(fragment),
                    REVISION,
                    true,
                    &request(Some(ORIGIN), None),
                ),
                Err(StatusCode::FORBIDDEN),
                "unexpectedly authorized fragment {fragment}"
            );
        }

        let mut top_level_query = url("/shortcuts");
        top_level_query.set_query(Some("_t=1793144658628"));
        assert_eq!(
            authorize(
                &label,
                &label,
                &top_level_query,
                REVISION,
                true,
                &request(Some(ORIGIN), None),
            ),
            Err(StatusCode::FORBIDDEN),
            "top-level URL query remains forbidden"
        );

        let wrong_session_url = Url::parse(
            "atools-settings://22222222222242228222222222222222.localhost/index.html#/shortcuts?_t=1793144658628",
        )
        .unwrap();
        assert_eq!(
            authorize(
                &label,
                &label,
                &wrong_session_url,
                REVISION,
                true,
                &request(Some(ORIGIN), None),
            ),
            Err(StatusCode::FORBIDDEN),
            "the timestamp query must not weaken session URL binding"
        );
    }

    #[test]
    fn rejects_other_roles_routes_origins_and_revisions() {
        let label = format!("ztools-settings-{ID}");
        let valid_url = url("/allCommands");
        let valid_origin = request(Some(ORIGIN), None);

        assert_eq!(
            authorize(
                "plugin-child",
                &label,
                &valid_url,
                REVISION,
                true,
                &valid_origin
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize(
                &label,
                &label,
                &url("/plugins"),
                REVISION,
                true,
                &valid_origin,
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize(
                "ztools-settings-22222222222242228222222222222222",
                &label,
                &valid_url,
                REVISION,
                true,
                &valid_origin,
            ),
            Err(StatusCode::FORBIDDEN),
            "retired session label must not inherit the current session"
        );
        assert_eq!(
            authorize(
                &label,
                &label,
                &valid_url,
                REVISION,
                true,
                &request(Some("null"), None),
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize(
                &label,
                &label,
                &valid_url,
                REVISION,
                true,
                &request(
                    Some("atools-settings://22222222222242228222222222222222.localhost"),
                    None
                ),
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize(
                &label,
                &label,
                &valid_url,
                "retired-revision",
                true,
                &valid_origin
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize(&label, &label, &valid_url, REVISION, false, &valid_origin),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn rejects_query_and_wrong_referer_even_with_a_matching_origin() {
        let label = format!("ztools-settings-{ID}");
        let mut queried = url("/shortcuts");
        queried.set_query(Some("route=forged"));
        assert_eq!(
            authorize(
                &label,
                &label,
                &queried,
                REVISION,
                true,
                &request(Some(ORIGIN), None),
            ),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize(
                &label,
                &label,
                &url("/shortcuts"),
                REVISION,
                true,
                &request(
                    Some(ORIGIN),
                    Some("atools-settings://22222222222242228222222222222222.localhost/index.html#/shortcuts"),
                ),
            ),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn accepts_same_origin_referer_and_rejects_null_or_cross_origin() {
        assert_eq!(
            authorize_child_origin_headers(
                ORIGIN,
                ID,
                &request(None, Some("atools-settings://11111111111141118111111111111111.localhost/index.html#/allCommands")),
            ),
            Ok(None)
        );
        assert_eq!(
            authorize_child_origin_headers(ORIGIN, ID, &request(Some("null"), None)),
            Err(StatusCode::FORBIDDEN)
        );
        assert_eq!(
            authorize_child_origin_headers(
                ORIGIN,
                ID,
                &request(None, Some("tauri://localhost/index.html#/allCommands")),
            ),
            Err(StatusCode::FORBIDDEN)
        );
    }
}
