//! The global quick-add hotkey and its small always-on-top popup window.

use crate::config::ConfigStore;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub const LABEL: &str = "quickadd";
const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 190.0;

/// Built once at startup and kept hidden so it appears instantly.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("quickadd.html".into()))
        .title("Quick add")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(true)
        .build()?;
    let w = win.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Focused(false) = e {
            let _ = w.hide();
        }
    });
    Ok(win)
}

/// Shows the popup centred on whichever monitor the mouse is on, or hides it.
pub fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if let (Ok(cursor), Ok(monitors)) = (app.cursor_position(), win.available_monitors()) {
        let hit = monitors.iter().find(|m| {
            let (p, s) = (m.position(), m.size());
            cursor.x >= p.x as f64
                && cursor.x < (p.x + s.width as i32) as f64
                && cursor.y >= p.y as f64
                && cursor.y < (p.y + s.height as i32) as f64
        });
        if let Some(m) = hit {
            let scale = m.scale_factor();
            let (p, s) = (m.position(), m.size());
            let w = (WIDTH * scale) as i32;
            let x = p.x + (s.width as i32 - w) / 2;
            let y = p.y + (s.height as f64 * 0.28) as i32;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

pub fn register(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.register(shortcut).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_quick_add_shortcut(app: AppHandle, store: tauri::State<ConfigStore>, shortcut: String) -> Result<(), String> {
    let old = store.get().quick_add_shortcut;
    if let Err(e) = register(&app, &shortcut) {
        let _ = register(&app, &old);
        return Err(format!("Couldn't use \"{shortcut}\": {e}. It may be taken by another app."));
    }
    store.update(|c| c.quick_add_shortcut = shortcut)?;
    Ok(())
}

#[tauri::command]
pub fn hide_quick_add(app: AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
