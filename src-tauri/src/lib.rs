mod backup;
mod config;
mod db;
mod oauth;
mod garmin;
mod weather;
mod watch;
mod quickadd;
mod window;

use config::{AppConfig, ConfigStore};
use db::{Db, ExecResult, Statement};
use serde_json::{Map, Value as Json};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_opener::OpenerExt;

pub struct DataDir(pub PathBuf);

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

// ---- Storage commands ------------------------------------------------------

#[tauri::command]
fn db_select(db: tauri::State<Db>, sql: String, params: Vec<Json>) -> Result<Vec<Map<String, Json>>, String> {
    db.select(&sql, &params).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_execute(db: tauri::State<Db>, sql: String, params: Vec<Json>) -> Result<ExecResult, String> {
    db.execute(&sql, &params).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_batch(db: tauri::State<Db>, statements: Vec<Statement>) -> Result<Vec<ExecResult>, String> {
    db.batch(&statements).map_err(|e| e.to_string())
}

// ---- Backups and data folder ----------------------------------------------

#[tauri::command]
fn backup_now(db: tauri::State<Db>, dir: tauri::State<DataDir>) -> Result<backup::BackupStatus, String> {
    backup::ensure_daily_backup(&db, &dir.0, &today(), true)?;
    Ok(backup::status(&dir.0))
}

#[tauri::command]
fn backup_status(dir: tauri::State<DataDir>) -> backup::BackupStatus {
    backup::status(&dir.0)
}

#[tauri::command]
fn data_folder(dir: tauri::State<DataDir>) -> String {
    dir.0.to_string_lossy().into()
}

#[tauri::command]
fn open_data_folder(app: AppHandle, dir: tauri::State<DataDir>) -> Result<(), String> {
    app.opener().open_path(dir.0.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Small JSON files the user (or Claude) can edit, e.g. training-plan.json.
/// Only plain names in the data folder are allowed.
fn data_file_path(dir: &DataDir, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.ends_with(".json")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.contains("..");
    if !ok || name == "config.json" {
        return Err(format!("\"{name}\" isn't a file the app can read"));
    }
    Ok(dir.0.join(name))
}

#[tauri::command]
fn read_data_file(dir: tauri::State<DataDir>, name: String) -> Result<Option<String>, String> {
    let path = data_file_path(&dir, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn write_data_file(dir: tauri::State<DataDir>, name: String, contents: String) -> Result<(), String> {
    let path = data_file_path(&dir, &name)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Opens a Strava activity in the browser. Only numeric ids, only strava.com.
#[tauri::command]
fn open_strava_activity(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Not a Strava activity id".into());
    }
    app.opener().open_url(format!("https://www.strava.com/activities/{id}"), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config(store: tauri::State<ConfigStore>) -> AppConfig {
    store.get()
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn start_backup_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let (Some(db), Some(dir)) = (app.try_state::<Db>(), app.try_state::<DataDir>()) {
            match backup::ensure_daily_backup(&db, &dir.0, &today(), false) {
                Ok(Some(p)) => log::info!("daily backup written to {}", p.display()),
                Ok(None) => {}
                Err(e) => log::error!("daily backup failed: {e}"),
            }
        }
        std::thread::sleep(Duration::from_secs(30 * 60));
    });
}

pub fn run() {
    tauri::Builder::default()
        // Must be first: a second launch just brings the running dashboard back.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            match (app.get_webview_window(window::MAIN), app.try_state::<ConfigStore>()) {
                (Some(win), Some(store)) => window::place(&win, &store, true),
                // The dashboard window is gone but the process lingered: start afresh.
                _ => app.restart(),
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        quickadd::toggle(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = app.path().data_dir()?.join("CommandCentre");
            std::fs::create_dir_all(&data_dir)?;
            log::info!("data folder: {}", data_dir.display());

            let db = Db::open(&data_dir.join("command-centre.db"))?;
            let store = ConfigStore::load(&data_dir);
            app.manage(db);
            app.manage(
                reqwest::Client::builder()
                    .user_agent("CommandCentre/0.2")
                    .connect_timeout(Duration::from_secs(10))
                    .build()?,
            );
            app.manage(DataDir(data_dir));
            app.manage(watch::WatchState::default());

            // Launch at login is on by default for the installed app; turning it off in settings sticks.
            let cfg = store.get();
            if !cfg.autostart_initialised && !cfg!(debug_assertions) {
                if let Err(e) = handle.autolaunch().enable() {
                    log::warn!("couldn't enable launch at login: {e}");
                }
                let _ = store.update(|c| c.autostart_initialised = true);
            }

            if let Err(e) = quickadd::register(&handle, &cfg.quick_add_shortcut) {
                log::warn!("quick-add shortcut {} unavailable: {e}", cfg.quick_add_shortcut);
            }
            quickadd::create(&handle)?;
            app.manage(store);

            if let Some(win) = app.get_webview_window(window::MAIN) {
                window::place(&win, &app.state::<ConfigStore>(), true);
            }
            window::start_watchdog(handle.clone());
            start_backup_scheduler(handle);
            Ok(())
        })
        // Closing the dashboard quits the whole app. Without this the hidden quick-add
        // window kept the process alive with no dashboard, and relaunching did nothing.
        .on_window_event(|window, event| {
            if window.label() == window::MAIN && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            db_select,
            db_execute,
            db_batch,
            backup_now,
            backup_status,
            data_folder,
            open_data_folder,
            get_config,
            app_version,
            read_data_file,
            open_strava_activity,
            write_data_file,
            oauth::oauth_status,
            oauth::oauth_set_client,
            oauth::oauth_disconnect,
            oauth::oauth_connect,
            oauth::api_request,
            oauth::ics_list,
            oauth::ics_add,
            oauth::ics_remove,
            oauth::ics_fetch,
            garmin::garmin_status,
            garmin::garmin_disconnect,
            garmin::garmin_connect,
            garmin::garmin_request,
            weather::weather_fetch,
            watch::watch_status,
            watch::watch_connect,
            watch::watch_call,
            watch::watch_disconnect,
            window::list_monitors,
            window::set_monitor,
            window::set_fullscreen_mode,
            quickadd::set_quick_add_shortcut,
            quickadd::hide_quick_add,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Command Centre");
}
