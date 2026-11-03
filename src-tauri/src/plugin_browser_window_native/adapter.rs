use tauri::{
    webview::{Color, NewWindowResponse, PageLoadEvent},
    App, AppHandle, LogicalSize, Manager, PixelUnit, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, WindowSizeConstraints, Wry,
};

use super::{
    options::WindowSpec,
    platform::{configure_fullscreenable, skip_taskbar_behavior, SkipTaskbarBehavior},
    size_policy::{ConstraintBasis, FrameMetrics},
    snapshot::{forget_window, remember_constraints, NativeConstraints},
};

const NATIVE_SHELL_PATH: &str = "/atools-native-window.html";

/// Install a reservation-only popup handler on a trusted parent WebView.
pub fn attach_parent<'a>(
    builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
    app: &AppHandle,
    parent: &str,
) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let app = app.clone();
    let parent = parent.to_string();
    builder.on_new_window(move |url, features| {
        if !is_shell_route(&url) {
            return NewWindowResponse::Deny;
        }
        let Some(parent_window) = app.get_webview_window(&parent) else {
            return NewWindowResponse::Deny;
        };
        let spec =
            match crate::plugin_browser_window_runtime::consume_popup(&app, &parent_window, &url) {
                Ok(Some(spec)) => spec,
                _ => return NewWindowResponse::Deny,
            };
        if spec.validate().is_err() {
            crate::plugin_browser_window_runtime::native_build_failed(&app, spec.label());
            return NewWindowResponse::Deny;
        }
        build_reserved_child(&app, url, features, spec)
            .map(|window| NewWindowResponse::Create { window })
            .unwrap_or(NewWindowResponse::Deny)
    })
}

/// Build the configured main window manually so all windows use the same
/// reservation gate before the setup callback starts tray and hotkey services.
pub fn create_main_from_config(app: &mut App<Wry>) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .ok_or_else(|| "ERR_ATOOLS_NATIVE_WINDOW_CONFIG: missing main window config".to_string())?
        .clone();
    if config.create {
        return Err("ERR_ATOOLS_NATIVE_WINDOW_CONFIG: main window must set create=false".into());
    }
    let app_handle = app.handle().clone();
    crate::renderer_main_drop::prepare(&app_handle);
    #[cfg(feature = "ztools-multiwebview")]
    let settings_main_instance = crate::renderer_settings_view::prepare_main(&app_handle)?;
    let builder = WebviewWindowBuilder::from_config(app.handle(), &config)
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_CONFIG: {error}"))?;
    let main = attach_parent(builder, &app_handle, "main")
        .on_page_load(move |main, payload| {
            crate::renderer_main_drop::on_page_load(main.as_ref(), &payload);
            #[cfg(feature = "ztools-multiwebview")]
            crate::renderer_settings_view::on_main_page_load(
                main.as_ref(),
                &payload,
                settings_main_instance,
            );
        })
        .build()
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_CONFIG: {error}"))?;
    #[cfg(feature = "ztools-multiwebview")]
    {
        let settings_app = app_handle.clone();
        main.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                crate::renderer_settings_view::on_main_destroyed_instance(
                    &settings_app,
                    settings_main_instance,
                );
            }
        });
    }
    crate::renderer_main_drop::bind_created(&main, |main| {
        crate::renderer_main_drop::bind_main(main.as_ref())
    })?;
    Ok(())
}

fn build_reserved_child(
    app: &AppHandle,
    child_url: tauri::Url,
    features: tauri::webview::NewWindowFeatures,
    spec: WindowSpec,
) -> Result<WebviewWindow, String> {
    let expected_url = child_url.clone();
    let navigation_url = expected_url.clone();
    let loaded_app = app.clone();
    let loaded_label = spec.label.clone();
    let mut builder = WebviewWindowBuilder::new(
        app,
        spec.label.clone(),
        WebviewUrl::External(child_url.clone()),
    )
    .window_features(features)
    .title(spec.title.clone())
    .inner_size(spec.width, spec.height)
    .decorations(spec.frame)
    .transparent(spec.transparent)
    .always_on_top(spec.always_on_top)
    .resizable(spec.resizable)
    .closable(spec.closable)
    .focused(false)
    .focusable(spec.focusable)
    .visible(false)
    .fullscreen(spec.fullscreen)
    .visible_on_all_workspaces(spec.visible_on_all_workspaces)
    .on_navigation(move |url| url == &navigation_url)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(move |window, payload| {
        if payload.event() == PageLoadEvent::Finished && payload.url() == &expected_url {
            crate::plugin_browser_window_runtime::native_loaded(&loaded_app, &loaded_label);
        }
        let _ = window;
    });
    if !spec.background_throttling {
        builder = builder
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    }
    if let Some([red, green, blue, alpha]) = spec.background_color {
        builder = builder.background_color(Color(red, green, blue, alpha));
    }
    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.shadow(spec.has_shadow);
    }
    #[cfg(not(target_os = "linux"))]
    {
        builder = builder
            .minimizable(spec.minimizable)
            .maximizable(spec.maximizable);
    }
    match skip_taskbar_behavior(spec.skip_taskbar) {
        SkipTaskbarBehavior::Noop => {
            // Electron accepts but does not change macOS app activation policy.
        }
        SkipTaskbarBehavior::Native(enabled) => {
            builder = builder.skip_taskbar(enabled);
        }
    }
    if let Some(x) = spec.x {
        builder = builder.position(x, spec.y.expect("validated paired native position"));
    } else {
        // Explicitly replace any position inherited from WindowFeatures with
        // manager-controlled default placement.
        builder = builder.center();
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            crate::plugin_browser_window_runtime::native_build_failed(app, &spec.label);
            return Err(format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"));
        }
    };
    attach_events(app, &window);
    let constraints = constraints_from_spec(&spec);
    remember_constraints(window.label(), constraints);
    crate::plugin_browser_window_runtime::native_created(app, window.label());

    let post_build = (|| {
        super::dragging::register_window(window.label(), &window)?;
        let metrics = measure_frame_metrics(&window)?;
        let inner_constraints = metrics.inner_constraints(constraints)?;
        let inner_size = if spec.use_content_size {
            metrics.validate_content_size([spec.width, spec.height])?;
            None
        } else {
            Some(metrics.content_size_for_outer([spec.width, spec.height])?)
        };
        // Finish both conversions before queuing either native mutation.
        if let Some(inner_size) = inner_size {
            window
                .set_size(Size::Logical(LogicalSize::new(
                    inner_size[0],
                    inner_size[1],
                )))
                .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
        }
        if has_constraints(inner_constraints) {
            window
                .set_size_constraints(to_native_constraints(inner_constraints))
                .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
        }
        configure_fullscreenable(&window, spec.fullscreenable)?;
        if spec.ignore_mouse_events {
            window
                .set_ignore_cursor_events(true)
                .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = post_build {
        let label = window.label().to_string();
        forget_window(app, &label);
        // Build succeeded, so the runtime keeps its budget until the actual
        // Destroyed callback arrives; destroy() only queues the native event.
        let _ = window.destroy();
        return Err(error);
    }
    Ok(window)
}

/// Measure the decoration delta once, in physical pixels, for one creation
/// operation. The same sample drives initial size and constraint conversion.
fn measure_frame_metrics(window: &WebviewWindow) -> Result<FrameMetrics, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
    let outer = window
        .outer_size()
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
    let inner = window
        .inner_size()
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {error}"))?;
    FrameMetrics::new(
        scale,
        [outer.width, outer.height],
        [inner.width, inner.height],
    )
}

fn attach_events(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        let kind = match event {
            WindowEvent::Moved(_) => "Moved",
            WindowEvent::Resized(_) => "Resized",
            WindowEvent::Focused(_) => "Focused",
            WindowEvent::ScaleFactorChanged { .. } => "ScaleFactorChanged",
            WindowEvent::Destroyed => "Destroyed",
            _ => return,
        };
        crate::plugin_browser_window_runtime::native_event(&app, &label, kind);
        if matches!(event, WindowEvent::Destroyed) {
            crate::plugin_browser_window_runtime::native_destroyed(&app, &label);
            forget_window(&app, &label);
        }
    });
}

fn is_shell_route(url: &tauri::Url) -> bool {
    let Some(ticket) = url.fragment() else {
        return false;
    };
    url.path() == NATIVE_SHELL_PATH
        && url.query().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && ticket.len() >= 16
        && ticket.len() <= 256
        && ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn constraints_from_spec(spec: &WindowSpec) -> NativeConstraints {
    NativeConstraints {
        min_width: spec.min_width,
        min_height: spec.min_height,
        max_width: spec.max_width,
        max_height: spec.max_height,
        basis: if spec.use_content_size {
            ConstraintBasis::Content
        } else {
            ConstraintBasis::Outer
        },
    }
}

fn to_native_constraints(value: NativeConstraints) -> WindowSizeConstraints {
    fn unit(value: Option<f64>) -> Option<PixelUnit> {
        value
            .filter(|value| *value > 0.0)
            .map(|value| PixelUnit::Logical(value.into()))
    }
    WindowSizeConstraints {
        min_width: unit(value.min_width),
        min_height: unit(value.min_height),
        max_width: unit(value.max_width),
        max_height: unit(value.max_height),
    }
}

fn has_constraints(value: NativeConstraints) -> bool {
    value.minimum().into_iter().any(|size| size > 0.0)
        || value.maximum().into_iter().any(|size| size > 0.0)
}
