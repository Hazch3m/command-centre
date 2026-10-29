//! App-level settings the backend needs before the UI loads (which monitor, hotkey).
//! Stored as `config.json` in the data folder. Card settings live in SQLite instead.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MonitorRef {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub monitor: Option<MonitorRef>,
    #[serde(default = "default_shortcut")]
    pub quick_add_shortcut: String,
    /// Set after the first run has turned on launch-at-login, so turning it off sticks.
    #[serde(default)]
    pub autostart_initialised: bool,
    /// When false the window is a normal window (handy while setting things up).
    #[serde(default = "default_true")]
    pub fullscreen: bool,
}

fn default_shortcut() -> String {
    DEFAULT_SHORTCUT.into()
}
fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig { monitor: None, quick_add_shortcut: default_shortcut(), autostart_initialised: false, fullscreen: true }
    }
}

pub struct ConfigStore {
    path: PathBuf,
    pub current: Mutex<AppConfig>,
}

impl ConfigStore {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("config.json");
        let current = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        ConfigStore { path, current: Mutex::new(current) }
    }

    pub fn get(&self) -> AppConfig {
        self.current.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut AppConfig)) -> Result<AppConfig, String> {
        let mut cfg = self.current.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut cfg);
        // Atomic write: never leave a truncated config behind.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&*cfg).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        Ok(cfg.clone())
    }
}
