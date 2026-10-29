//! Keeps the dashboard full-screen on the chosen monitor.
//!
//! Windows moves windows to the primary screen when a monitor sleeps or is
//! unplugged, so a watchdog re-applies the placement every few seconds once the
//! chosen monitor is back.

use crate::config::{ConfigStore, MonitorRef};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// True when *we* minimised the window because its monitor went away. A window the
/// user minimised themselves (e.g. Win+D) is left alone until they restore it.
static WE_MINIMISED: AtomicBool = AtomicBool::new(false);
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, WebviewWindow};

pub const MAIN: &str = "main";

#[derive(Serialize)]
pub struct MonitorInfo {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
    pub current: bool,
    pub chosen: bool,
}

fn to_ref(m: &Monitor) -> MonitorRef {
    MonitorRef {
        name: m.name().cloned().unwrap_or_default(),
        x: m.position().x,
        y: m.position().y,
        width: m.size().width,
        height: m.size().height,
    }
}

/// Picks the saved monitor among those connected. Display names on Windows
/// (`\\.\DISPLAY2`) can be reassigned after reconnecting, so we match on name and
/// geometry together first, then geometry, then size, then name alone.
pub fn choose(saved: Option<&MonitorRef>, available: &[MonitorRef]) -> Option<usize> {
    let s = saved?;
    let same_size = |m: &MonitorRef| m.width == s.width && m.height == s.height;
    let same_pos = |m: &MonitorRef| m.x == s.x && m.y == s.y;
    available
        .iter()
        .position(|m| m.name == s.name && same_size(m) && same_pos(m))
        .or_else(|| available.iter().position(|m| same_size(m) && same_pos(m)))
        .or_else(|| available.iter().position(|m| m.name == s.name && same_size(m)))
        .or_else(|| {
            let sized: Vec<usize> = available.iter().enumerate().filter(|(_, m)| same_size(m)).map(|(i, _)| i).collect();
            if sized.len() == 1 { Some(sized[0]) } else { None }
        })
        .or_else(|| available.iter().position(|m| m.name == s.name))
}

enum Target {
    /// Put the dashboard here; the bool says whether full-screen is allowed.
    Monitor(Monitor, bool),
    /// The chosen monitor is asleep or unplugged.
    Missing,
}

fn resolve(win: &WebviewWindow, store: &ConfigStore) -> Option<Target> {
    let monitors = win.available_monitors().ok()?;
    let refs: Vec<MonitorRef> = monitors.iter().map(to_ref).collect();
    let cfg = store.get();
    if let Some(saved) = cfg.monitor.as_ref() {
        return Some(match choose(Some(saved), &refs) {
            Some(i) => Target::Monitor(monitors.into_iter().nth(i)?, cfg.fullscreen),
            None => Target::Missing,
        });
    }
    // First run: prefer a secondary monitor (portrait first) and remember it.
    let primary = win.primary_monitor().ok().flatten();
    let is_primary = |m: &Monitor| primary.as_ref().map(|p| same_monitor(p, m)).unwrap_or(false);
    let pick = monitors
        .iter()
        .position(|m| !is_primary(m) && m.size().height > m.size().width)
        .or_else(|| monitors.iter().position(|m| !is_primary(m)));
    match pick {
        Some(i) => {
            let r = to_ref(&monitors[i]);
            let _ = store.update(|c| c.monitor = Some(r));
            Some(Target::Monitor(monitors.into_iter().nth(i)?, cfg.fullscreen))
        }
        // Only one screen: open as a normal maximised window so it never traps the main display.
        None => Some(Target::Monitor(primary.or_else(|| monitors.into_iter().next())?, false)),
    }
}

fn same_monitor(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size()
}

/// Moves the window onto the target monitor and makes it full-screen there.
/// If the chosen monitor has gone (asleep/unplugged) the dashboard is minimised
/// instead of being dumped full-screen over the main display.
pub fn place(win: &WebviewWindow, store: &ConfigStore, force: bool) {
    let Some(target) = resolve(win, store) else { return };
    let (target, want_fullscreen) = match target {
        Target::Missing => {
            if !win.is_minimized().unwrap_or(false) {
                log::info!("chosen monitor missing; minimising dashboard");
                WE_MINIMISED.store(true, Ordering::Relaxed);
                let _ = win.set_fullscreen(false);
                let _ = win.minimize();
            }
            return;
        }
        Target::Monitor(m, fs) => (m, fs),
    };
    let minimized = win.is_minimized().unwrap_or(false);
    let current = win.current_monitor().ok().flatten();
    let on_target = current.as_ref().map(|c| same_monitor(c, &target)).unwrap_or(false);
    let is_fs = win.is_fullscreen().unwrap_or(false);
    if !force && !minimized && on_target && is_fs == want_fullscreen {
        return;
    }
    log::info!("placing dashboard on {:?} (fullscreen={want_fullscreen})", target.name());
    if minimized {
        let _ = win.unminimize();
    }
    WE_MINIMISED.store(false, Ordering::Relaxed);
    if is_fs {
        let _ = win.set_fullscreen(false);
    }
    let _ = win.unmaximize();
    let pos = target.position();
    let _ = win.set_position(PhysicalPosition::new(pos.x + 40, pos.y + 40));
    if want_fullscreen {
        let _ = win.set_fullscreen(true);
    } else {
        let _ = win.maximize();
    }
    let _ = win.show();
}


pub fn start_watchdog(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        let (Some(win), Some(store)) = (app.get_webview_window(MAIN), app.try_state::<ConfigStore>()) else { continue };
        if win.is_minimized().unwrap_or(false) && !WE_MINIMISED.load(Ordering::Relaxed) {
            continue;
        }
        place(&win, &store, false);
    });
}

#[tauri::command]
pub fn list_monitors(app: AppHandle, store: tauri::State<ConfigStore>) -> Result<Vec<MonitorInfo>, String> {
    let win = app.get_webview_window(MAIN).ok_or("no main window")?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let primary = win.primary_monitor().ok().flatten();
    let current = win.current_monitor().ok().flatten();
    let refs: Vec<MonitorRef> = monitors.iter().map(to_ref).collect();
    let chosen = choose(store.get().monitor.as_ref(), &refs);
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            name: m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
            primary: primary.as_ref().map(|p| same_monitor(p, m)).unwrap_or(false),
            current: current.as_ref().map(|c| same_monitor(c, m)).unwrap_or(false),
            chosen: chosen == Some(i),
        })
        .collect())
}

#[tauri::command]
pub fn set_monitor(app: AppHandle, store: tauri::State<ConfigStore>, name: String, x: i32, y: i32) -> Result<(), String> {
    let win = app.get_webview_window(MAIN).ok_or("no main window")?;
    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let m = monitors
        .iter()
        .find(|m| m.name().map(|n| n == &name).unwrap_or(false) && m.position().x == x && m.position().y == y)
        .ok_or("That monitor is no longer connected")?;
    let r = to_ref(m);
    store.update(|c| c.monitor = Some(r))?;
    place(&win, &store, true);
    Ok(())
}

#[tauri::command]
pub fn set_fullscreen_mode(app: AppHandle, store: tauri::State<ConfigStore>, fullscreen: bool) -> Result<(), String> {
    store.update(|c| c.fullscreen = fullscreen)?;
    let win = app.get_webview_window(MAIN).ok_or("no main window")?;
    place(&win, &store, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn m(name: &str, x: i32, y: i32, w: u32, h: u32) -> MonitorRef {
        MonitorRef { name: name.into(), x, y, width: w, height: h }
    }

    #[test]
    fn chooses_saved_monitor_even_if_renamed() {
        let saved = m(r"\\.\DISPLAY2", 2560, -560, 1440, 2560);
        let now = vec![m(r"\\.\DISPLAY1", 0, 0, 2560, 1440), m(r"\\.\DISPLAY3", 2560, -560, 1440, 2560)];
        assert_eq!(choose(Some(&saved), &now), Some(1));
        // Moved in Windows display settings but still the only portrait screen.
        let moved = vec![m(r"\\.\DISPLAY1", 0, 0, 2560, 1440), m(r"\\.\DISPLAY2", -1440, 0, 1440, 2560)];
        assert_eq!(choose(Some(&saved), &moved), Some(1));
        // Unplugged: fall back (caller uses primary).
        assert_eq!(choose(Some(&saved), &[m(r"\\.\DISPLAY1", 0, 0, 2560, 1440)]), None);
        assert_eq!(choose(None, &now), None);
    }
}
