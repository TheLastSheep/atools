//! Opt-in acceptance of the original main renderer through the real host seam.
//! All application data is temporary; ordinary startup services are omitted.

mod assets;
#[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
mod builtin_state;
#[cfg(not(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview")))]
mod builtin_state {
    use super::profile::Profile;

    pub(super) fn prepare(profile: &Profile) -> Result<bool, String> {
        profile.prepare()?;
        Ok(false)
    }
}
mod catalog_journey;
#[cfg(target_os = "macos")]
mod clipboard_context_journey;
mod clipboard_context_wiring;
mod controller;
mod disabled_clipboard;
mod exit_status;
mod fallback_settings;
mod fixture_owner;
mod journey_dispatch;
#[cfg(feature = "legacy-node-smoke")]
mod launch_return_journey;
#[cfg(feature = "legacy-node-smoke")]
mod launcher_journey;
pub(crate) mod main_drop_probe;
#[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
mod main_panel_journey;
pub(crate) mod manual_ui;
#[cfg(feature = "ztools-multiwebview")]
mod multiwebview;
mod observations;
pub(crate) mod profile;
#[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
pub(crate) mod settings_height;
#[cfg(feature = "ztools-multiwebview")]
mod settings_input_activation;
#[cfg(feature = "ztools-multiwebview")]
mod settings_input_journey;
#[cfg(feature = "ztools-multiwebview")]
mod settings_journey;
mod startup_profile;
pub(crate) mod updater_journey;

use atools_core::{AppConfig, Database};
use serde_json::json;
use std::sync::{
    atomic::{AtomicI32, Ordering},
    Arc,
};
use tauri::Manager;

use crate::{pasteboard_runtime::PasteboardRuntime, state::AppState};

pub(super) use disabled_clipboard::DisabledClipboard;

pub(super) struct FixtureMetadata(pub(super) serde_json::Value);

pub(super) struct FixtureExitStatus {
    pub(super) code: AtomicI32,
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Native main-renderer acceptance currently targets macOS".into());
    }
    let profile = Arc::new(profile::Profile::from_args(
        &std::env::args().skip(1).collect::<Vec<_>>(),
    )?);
    main_drop_probe::validate_requested(&profile)?;
    #[cfg(all(feature = "legacy-node-smoke", feature = "ztools-multiwebview"))]
    if profile.settings_height_case.is_some() {
        return settings_height::run(profile);
    }
    if builtin_state::prepare(&profile)? {
        return Ok(());
    }
    let renderer_assets = assets::RendererAssets::load(&profile.dist)?;
    let updater_main_role = updater_journey::bind_main(&profile, &renderer_assets)?;
    #[cfg(feature = "ztools-multiwebview")]
    let renderer_assets = {
        let mut assets = renderer_assets;
        if !profile.manual_ui && !profile.updater_journey {
            assets.add_multiwebview_probes()?;
        }
        assets
    };
    let mut renderer_assets = renderer_assets;
    let fallback_settings_assets = fallback_settings::add_assets(&mut renderer_assets, &profile)?;
    let metadata = FixtureMetadata(json!({
        "assets": renderer_assets.metrics(),
        "fallbackSettingsAssets": fallback_settings_assets,
        "host": "shared-production-command-registry-and-window-lifecycle",
        "startup": startup_profile::startup_label(&profile),
        "renderer": "unchanged-original-vue",
        "journey": if profile.updater_journey { "updater" } else if profile.manual_ui { "manual-ui" } else if profile.clipboard_context_journey {
            "clipboard-context"
        } else if profile.main_panel_journey {
            "main-panel"
        } else if profile.settings_input_journey {
            "settings-input"
        } else if profile.settings_journey {
            "settings"
        } else if profile.launcher_journey {
            "launcher"
        } else if profile.launch_return_journey {
            "launch-return"
        } else if profile.catalog_journey {
            "catalog"
        } else {
            "focus"
        },
        "dataStore": "nonpersistent",
        "multiwebview": cfg!(feature = "ztools-multiwebview"),
    }));
    let config = AppConfig::with_base_dir(profile.root.join("app-data"));
    config.ensure_dirs().map_err(|error| error.to_string())?;
    let db = Arc::new(Database::open(&config.db_path()).map_err(|error| error.to_string())?);
    let updater_harness =
        updater_journey::prepare(Arc::clone(&profile), Arc::clone(&db), updater_main_role)?;
    if profile.manual_ui {
        db.set_setting("settings-general", &json!({"theme":"dark", "autoPaste":"off", "autoClear":"never", "autoBackToSearch":"never", "opacity":1.0, "showTrayIcon":false}).to_string()).map_err(|e| e.to_string())?;
    } else if profile.updater_about {
        updater_journey::seed_about(&db, &profile)?;
    } else if profile.settings_journey {
        #[cfg(feature = "ztools-multiwebview")]
        settings_journey::seed_fixture(&db, &profile.auto_clear)?;
    } else if !profile.launcher_journey
        && !profile.launch_return_journey
        && !profile.catalog_journey
        && !profile.settings_input_journey
    {
        db.set_setting(
            "settings-general",
            &json!({
                "theme": "dark", "primaryColor": "blue", "autoClear": profile.auto_clear,
                "autoPaste": "never", "searchMode": "aggregate", "showMatchRecommendation": false,
            })
            .to_string(),
        )
        .map_err(|error| error.to_string())?;
    }
    #[cfg(feature = "legacy-node-smoke")]
    let launcher_prepared = if profile.launcher_journey {
        Some(launcher_journey::prepare(&profile, db.clone())?)
    } else {
        None
    };
    #[cfg(feature = "legacy-node-smoke")]
    let launch_return_prepared = if profile.launch_return_journey {
        Some(launch_return_journey::prepare(
            Arc::clone(&profile),
            db.clone(),
        )?)
    } else {
        None
    };
    let catalog_prepared = if profile.catalog_journey {
        Some(catalog_journey::prepare(
            Arc::clone(&profile),
            Arc::clone(&db),
        )?)
    } else {
        None
    };
    #[cfg(feature = "ztools-multiwebview")]
    let settings_input_harness = if profile.settings_input_journey {
        Some(settings_input_journey::prepare(
            Arc::clone(&profile),
            Arc::clone(&db),
        )?)
    } else {
        None
    };
    let clipboard = Arc::new(DisabledClipboard::default());
    let clipboard_fixture = clipboard_context_wiring::prepare(
        Arc::clone(&profile),
        Arc::clone(&db),
        clipboard.clone(),
    )?;
    let pasteboard = Arc::new(PasteboardRuntime::new(
        clipboard_fixture.backend(),
        db.clone(),
        &config,
    )?);
    #[cfg(feature = "ztools-multiwebview")]
    let (state, settings_input_inventory_harness) =
        settings_input_journey::prepare_app_state(Arc::clone(&profile), config, db, pasteboard)?;
    #[cfg(not(feature = "ztools-multiwebview"))]
    let state = AppState::new_prepopulated_inventory(config, db, None, pasteboard);
    #[cfg(feature = "legacy-node-smoke")]
    let (state, launcher_harness) = match launcher_prepared {
        Some(prepared) => (
            state.with_launcher_app_catalog(prepared.source),
            Some(prepared.harness),
        ),
        None => (state, None),
    };
    #[cfg(feature = "legacy-node-smoke")]
    let (state, launch_return_harness) = match launch_return_prepared {
        Some(prepared) => (
            state.with_launcher_app_catalog(prepared.source),
            Some(prepared.harness),
        ),
        None => (state, None),
    };
    let (state, catalog_harness) = match catalog_prepared {
        Some(prepared) => (
            state.with_launcher_app_catalog(prepared.source),
            Some(prepared.harness),
        ),
        None => (state, None),
    };
    let state = manual_ui::prepare_state(state, &profile)?;
    let manual_enabled = profile.manual_ui;
    let updater_enabled = profile.updater_journey;
    let catalog_enabled = profile.catalog_journey;
    let launch_return_enabled = profile.launch_return_journey;
    let settings_input_enabled = profile.settings_input_journey;
    let main_panel_enabled = profile.main_panel_journey;
    let clipboard_context_enabled = profile.clipboard_context_journey;
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    let main_panel_profile = Arc::clone(&profile);
    let builtin_state_enabled = profile.builtin_state_journey;
    #[cfg(feature = "ztools-multiwebview")]
    let settings_input_run_id = profile.run_id.clone();
    let exit_status = Arc::new(FixtureExitStatus {
        code: AtomicI32::new(1),
    });

    let mut context = tauri::generate_context!();
    context.set_assets(Box::new(renderer_assets));
    let settings = context.config_mut();
    settings.identifier = profile.identifier.clone();
    settings.build.dev_url = None;
    if updater_enabled {
        settings.build.frontend_dist = Some(tauri::utils::config::FrontendDist::Directory(
            "../packages/ztools-renderer/dist".into(),
        ));
    }
    settings.app.tray_icon = None;
    settings.app.windows.retain(|window| window.label == "main");
    settings.app.security.asset_protocol.enable = false;
    let main = settings
        .app
        .windows
        .first_mut()
        .ok_or("Missing production main window config")?;
    main.url = tauri::WebviewUrl::App("/".into());
    main.create = false;
    main.visible = false;
    main.focus = false;
    main.title = "ATools Renderer Acceptance".into();
    main.incognito = true;
    // macOS ignores data_directory; isolation uses the nonpersistent WK store.
    main.data_directory = None;

    let production_handler = crate::command_registry::handler();
    let clipboard_handler = clipboard_context_wiring::handler();
    let probe_handler = controller::handler();
    let catalog_handler = catalog_journey::handler();
    let updater_handler = updater_journey::handler();
    #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
    let main_panel_handler = main_panel_journey::handler();
    #[cfg(feature = "legacy-node-smoke")]
    let launcher_handler = launcher_journey::handler();
    #[cfg(feature = "legacy-node-smoke")]
    let launch_return_handler = launch_return_journey::handler();
    #[cfg(feature = "ztools-multiwebview")]
    let multiwebview_handler = multiwebview::handler();
    #[cfg(feature = "ztools-multiwebview")]
    let settings_journey_handler = settings_journey::handler();
    #[cfg(feature = "ztools-multiwebview")]
    let settings_input_handler = settings_input_journey::handler();
    #[cfg(feature = "ztools-multiwebview")]
    let settings_journey_enabled = profile.settings_journey;
    let builder = crate::app_builder::host_builder(state);
    let builder = startup_profile::with_profile_plugins(builder, &profile);
    let builder = manual_ui::manage(builder, Arc::clone(&profile));
    let builder = clipboard_fixture.manage(builder);
    let builder = match updater_harness {
        Some(harness) => builder.manage(harness),
        None => builder,
    };
    #[cfg(feature = "ztools-multiwebview")]
    let builder = match settings_input_harness {
        Some(harness) => builder.manage(harness),
        None => builder,
    };
    #[cfg(feature = "ztools-multiwebview")]
    let builder = match settings_input_inventory_harness {
        Some(harness) => builder.manage(harness),
        None => builder,
    };
    let builder = match catalog_harness {
        Some(harness) => builder.manage(harness),
        None => builder,
    };
    #[cfg(feature = "legacy-node-smoke")]
    let builder = match launcher_harness {
        Some(harness) => builder.manage(harness),
        None => builder,
    };
    #[cfg(feature = "legacy-node-smoke")]
    let builder = match launch_return_harness {
        Some(harness) => builder.manage(harness),
        None => builder,
    };
    #[cfg(feature = "ztools-multiwebview")]
    let builder = builder
        .manage(multiwebview::Harness::default())
        .manage(settings_journey::Harness::new(settings_journey_enabled));
    #[cfg(feature = "ztools-multiwebview")]
    let builder = if manual_enabled {
        builder
    } else {
        builder.plugin(tauri_plugin_fs::init())
    };
    let application = builder
        .manage(clipboard)
        .manage(exit_status.clone())
        .manage(metadata)
        .manage(controller::Harness::new(profile))
        .invoke_handler(move |invoke| {
            let invoke = match manual_ui::reject_if_blocked(invoke) {
                Ok(invoke) => invoke,
                Err(()) => return true,
            };
            if updater_journey::handles(invoke.message.command()) {
                return updater_handler(invoke);
            }
            clipboard_context_wiring::observe_command(&invoke);
            if clipboard_context_wiring::handles(invoke.message.command()) {
                return clipboard_handler(invoke);
            }
            #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
            if main_panel_journey::handles(invoke.message.command()) {
                return main_panel_handler(invoke);
            }
            #[cfg(feature = "ztools-multiwebview")]
            settings_input_journey::observe_command(&invoke);
            #[cfg(feature = "ztools-multiwebview")]
            if settings_input_journey::handles(invoke.message.command()) {
                return settings_input_handler(invoke);
            }
            if catalog_journey::handles(invoke.message.command()) {
                return catalog_handler(invoke);
            }
            #[cfg(feature = "legacy-node-smoke")]
            if launch_return_journey::handles(invoke.message.command()) {
                return launch_return_handler(invoke);
            }
            #[cfg(feature = "legacy-node-smoke")]
            if launcher_journey::handles(invoke.message.command()) {
                return launcher_handler(invoke);
            }
            #[cfg(feature = "ztools-multiwebview")]
            if multiwebview::handles(invoke.message.command()) {
                return multiwebview_handler(invoke);
            }
            #[cfg(feature = "ztools-multiwebview")]
            if settings_journey::handles(invoke.message.command()) {
                return settings_journey_handler(invoke);
            }
            if controller::handles(invoke.message.command()) {
                probe_handler(invoke)
            } else {
                production_handler(invoke)
            }
        })
        .on_page_load(journey_dispatch::on_page_load)
        .on_window_event(journey_dispatch::on_window_event)
        .setup(move |app| {
            app.manage(crate::plugin_detach_runtime::PluginDetachRuntime::default());
            crate::plugin_browser_window_runtime::install_manager(app.handle());
            crate::plugin_browser_window_native::create_main_from_config(app)?;
            manual_ui::setup(app.handle()).map_err(std::io::Error::other)?;
            updater_journey::setup_about(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(feature = "ztools-multiwebview")]
            {
                if settings_input_enabled {
                    crate::tray::setup_tray(app.handle())?;
                }
                let raw_general = app
                    .state::<crate::state::AppState>()
                    .inner()
                    .db
                    .get_setting("settings-general")
                    .ok()
                    .flatten();
                if settings_input_enabled {
                    crate::renderer_window_material::install_original_fixture(
                        app.handle(),
                        raw_general.as_deref(),
                    )
                    .map_err(std::io::Error::other)?;
                    crate::renderer_settings_view::presentation::install_hidden_smoke(
                        app.handle(),
                        &settings_input_run_id,
                    )
                    .map_err(std::io::Error::other)?;
                    settings_input_activation::install(app.handle())
                        .map_err(std::io::Error::other)?;
                    settings_input_journey::initialize_hotkey_recovery(app.handle());
                } else if manual_enabled {
                    crate::renderer_window_material::install_original_fixture(
                        app.handle(),
                        raw_general.as_deref(),
                    )
                    .map_err(std::io::Error::other)?;
                } else {
                    crate::renderer_window_material::install_configured(
                        app.handle(),
                        raw_general.as_deref(),
                    )
                    .map_err(std::io::Error::other)?;
                }
            }
            crate::renderer_context_menu::setup(app.handle());
            #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
            if main_panel_enabled {
                main_panel_journey::initialize(app.handle(), Arc::clone(&main_panel_profile))
                    .map_err(std::io::Error::other)?;
            }
            #[cfg(feature = "legacy-node-smoke")]
            if launch_return_enabled {
                launch_return_journey::install_native_witness(app.handle())
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            }
            // Permit WebKit initialization without requesting foreground during
            // Tauri setup. The foreground journey starts after RunEvent::Ready.
            if !manual_enabled
                && !catalog_enabled
                && !launch_return_enabled
                && !settings_input_enabled
                && !main_panel_enabled
                && !clipboard_context_enabled
                && !updater_enabled
            {
                crate::window::show_main_window_for_startup(app.handle())?;
            }
            Ok(())
        })
        .build(context)
        .map_err(|error| format!("Cannot build isolated main renderer: {error}"))?;
    let manual_app = application.handle().clone();
    let run_return_code = application.run_return(move |app, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Reopen { .. }) {
            manual_ui::reopen(app);
        }
        #[cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]
        if crate::window::macos_main_panel::is_active(app) {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                api.prevent_exit();
                return;
            }
        }
        if matches!(event, tauri::RunEvent::Ready)
            && journey_dispatch::start(app, builtin_state_enabled)
        {
            return;
        }
        if matches!(&event, tauri::RunEvent::Exit) {
            if let Err(error) = manual_ui::record_exit(app) {
                eprintln!("manual-ui exit report: {error}");
            }
        }
        crate::app_lifecycle::on_run_event(app, event);
    });

    if manual_ui::finish(&manual_app, run_return_code)? {
        return Ok(());
    }
    let fixture_exit_code = exit_status.code.load(Ordering::Acquire);
    exit_status::validate_exit_codes(run_return_code, fixture_exit_code)
}
