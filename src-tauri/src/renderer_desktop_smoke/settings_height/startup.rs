//! Minimal R68-owned host: deliberately omits desktop plugins and catalog watcher.
use super::super::{assets::RendererAssets, profile::Profile, DisabledClipboard};
use super::{commands, journey, report, source, Session};
use atools_core::{AppConfig, Database};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::Manager;

pub(in crate::renderer_desktop_smoke) fn run(profile: Arc<Profile>) -> Result<(), String> {
    let started = Instant::now();
    profile.prepare()?;
    profile.validate_settings_height_fixture()?;
    let assets = RendererAssets::load(&profile.dist)?;
    let config = AppConfig::with_base_dir(profile.root.join("app-data"));
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let seed = source::import_seed(&profile, &config.db_path())?;
    let db = Arc::new(Database::open(&config.db_path()).map_err(|e| e.to_string())?);
    if profile.settings_height_case == Some(super::super::profile::HeightCase::A) {
        db.set_setting("settings-general", source::A_RAW)
            .map_err(|e| e.to_string())?;
    }
    journey::validate_initial_raw(&db, profile.settings_height_case.unwrap())?;
    let clipboard = Arc::new(DisabledClipboard::default());
    let pasteboard = Arc::new(crate::pasteboard_runtime::PasteboardRuntime::new(
        clipboard.clone(),
        db.clone(),
        &config,
    )?);
    let apps = profile.root.join("launcher-apps");
    std::fs::create_dir(&apps).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&apps, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let state = crate::state::AppState::new_prepopulated_inventory(config, db, None, pasteboard)
        .with_launcher_app_catalog(
        crate::launcher_app_catalog_source::LauncherAppCatalogSource::from_owned_fixture_directory(
            &apps,
        )?,
    );
    let mut context = tauri::generate_context!();
    context.set_assets(Box::new(assets));
    let settings = context.config_mut();
    settings.identifier = profile.identifier.clone();
    settings.build.dev_url = None;
    settings.app.tray_icon = None;
    settings.app.windows.retain(|window| window.label == "main");
    settings.app.security.asset_protocol.enable = false;
    settings.app.security.csp = Some(tauri::utils::config::Csp::Policy(
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'".into(),
    ));
    let main = settings
        .app
        .windows
        .first_mut()
        .ok_or("height main window config missing")?;
    main.url = tauri::WebviewUrl::App("/".into());
    main.create = false;
    main.visible = false;
    main.focus = false;
    main.incognito = true;
    main.data_directory = None;
    let production = crate::command_registry::handler();
    let builder = tauri::Builder::default()
        .manage(state)
        .manage(super::main_entry::LoadRuntime::default())
        .on_page_load(super::main_entry::on_page_load)
        .manage(crate::general_settings_runtime::GeneralSettingsCoordinator::default())
        .manage(crate::updater::UpdateCoordinator::default())
        .manage(crate::hotkey::main_dispatch::Runtime::default())
        .manage(crate::window::TransientBlurGuard::default())
        .manage(crate::window::AutoBackController::default())
        .on_window_event(crate::app_lifecycle::on_window_event);
    let builder = crate::renderer_settings_view::register(builder);
    let exit_code = Arc::new(AtomicI32::new(1));
    let app = builder
        .invoke_handler(move |invoke| commands::dispatch(invoke, &production))
        .setup(move |app| {
            let root = app.path().resource_dir()?.join("ztools-settings");
            let bundle = Arc::new(
                crate::renderer_settings_view::bundle::SettingsBundle::load(&root)
                    .map_err(std::io::Error::other)?,
            );
            let sources = source::Sources::new(&profile, root, bundle.revision().into())
                .map_err(std::io::Error::other)?;
            let initial = report::initial(&profile, seed.clone(), sources.report());
            app.manage(Session {
                profile: profile.clone(),
                sources,
                clipboard: clipboard.clone(),
                report: Mutex::new(initial),
                started,
                reported: AtomicBool::new(false),
                result_code: AtomicI32::new(1),
            });
            crate::renderer_settings_view::install_bundle(app.handle(), bundle)
                .map_err(std::io::Error::other)?;
            crate::renderer_settings_view::presentation::install_settings_height_hidden(
                app.handle(),
                &profile,
            )
            .map_err(std::io::Error::other)?;
            crate::plugin_browser_window_runtime::install_manager(app.handle());
            crate::plugin_browser_window_native::create_main_from_config(app)
                .map_err(std::io::Error::other)?;
            let raw = app
                .state::<crate::state::AppState>()
                .db
                .get_setting("settings-general")
                .ok()
                .flatten();
            crate::renderer_window_material::install_configured(app.handle(), raw.as_deref())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(context)
        .map_err(|e| e.to_string())?;
    let completed = exit_code.clone();
    let code = app.run_return(move |app, event| {
        let exiting = matches!(event, tauri::RunEvent::Exit);
        if matches!(event, tauri::RunEvent::Ready) {
            super::start(app.clone());
        }
        if matches!(event, tauri::RunEvent::Exit) {
            if !app.state::<Session>().reported.load(Ordering::Acquire) {
                report::error(
                    &app.state::<Session>(),
                    "height-exit-before-stage-completion",
                );
                completed.store(report::finish(app), Ordering::Release);
            } else {
                completed.store(
                    app.state::<Session>().result_code.load(Ordering::Acquire),
                    Ordering::Release,
                );
            }
        }
        crate::app_lifecycle::on_run_event(app, event);
        if exiting {
            let state = app.state::<Session>();
            let terminal = report::terminal_code(
                state.result_code.load(Ordering::Acquire),
                state.started.elapsed(),
            );
            state.result_code.store(terminal, Ordering::Release);
            completed.store(terminal, Ordering::Release);
        }
    });
    let terminal = report::terminal_code(exit_code.load(Ordering::Acquire), started.elapsed());
    super::super::exit_status::validate_exit_codes(code, terminal)
}
