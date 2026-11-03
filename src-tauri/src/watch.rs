//! The Watch module's link to garmin-coach: the app starts the user's own
//! garmin-coach MCP server (Python) as a child process and talks to it as an
//! MCP client over stdio, using the official Rust MCP SDK (rmcp). Nothing about
//! Garmin is reimplemented here: tool names and argument schemas come from the
//! server's own tool list.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{RoleClient, ServiceExt};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

const CALL_TIMEOUT: Duration = Duration::from_secs(90);
const START_TIMEOUT: Duration = Duration::from_secs(45);

struct Conn {
    key: String,
    service: RunningService<RoleClient, ()>,
    tools: Value,
}

#[derive(Default)]
pub struct WatchState {
    conn: Mutex<Option<Conn>>,
    /// Last lines the server wrote to stderr (Python tracebacks, login errors).
    stderr: Arc<StdMutex<VecDeque<String>>>,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// "~/x", "%USERPROFILE%\x" → absolute path.
pub fn expand(path: &str) -> PathBuf {
    let p = path.trim().trim_matches('"');
    let h = home();
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return h.join(rest);
    }
    if p == "~" {
        return h;
    }
    let lower = p.to_ascii_lowercase();
    if lower.starts_with("%userprofile%") {
        return h.join(p["%userprofile%".len()..].trim_start_matches(['\\', '/']));
    }
    PathBuf::from(p)
}

/// Folders where garmin-coach usually lives, in order.
fn candidate_folders() -> Vec<PathBuf> {
    let h = home();
    let mut out = Vec::new();
    for base in ["Downloads", "Documents", "Desktop", ""] {
        let b = if base.is_empty() { h.clone() } else { h.join(base) };
        out.push(b.join("garmin-coach-mcp").join("garmin-coach-mcp"));
        out.push(b.join("garmin-coach-mcp"));
    }
    out
}

/// A Python environment that has the `mcp` package installed.
fn venv_has_mcp(venv: &Path) -> bool {
    if venv.join("Lib").join("site-packages").join("mcp").is_dir() {
        return true; // Windows layout
    }
    let lib = venv.join("lib");
    std::fs::read_dir(&lib)
        .map(|it| it.flatten().any(|e| e.path().join("site-packages").join("mcp").is_dir()))
        .unwrap_or(false)
}

/// The Python that should run server.py: the folder's own .venv, or one beside it,
/// as long as it has the packages from requirements.txt installed.
pub fn find_python(folder: &Path) -> Option<PathBuf> {
    let mut venvs = vec![folder.join(".venv"), folder.join("venv")];
    if let Some(parent) = folder.parent() {
        venvs.push(parent.join(".venv"));
    }
    for v in venvs {
        if !venv_has_mcp(&v) {
            continue;
        }
        for exe in [v.join("Scripts").join("python.exe"), v.join("bin").join("python3"), v.join("bin").join("python")] {
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

fn tokens_dir() -> PathBuf {
    std::env::var("GARMIN_TOKENS").map(|t| expand(&t)).unwrap_or_else(|_| home().join(".garminconnect"))
}

fn tokens_present() -> bool {
    let d = tokens_dir();
    d.join("garmin_tokens.json").is_file() || d.join("oauth2_token.json").is_file()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    folder: String,
    server_found: bool,
    python: Option<String>,
    tokens_found: bool,
    tokens_dir: String,
    running: bool,
    stderr: Vec<String>,
}

fn resolve(folder: &str, python: &str) -> (PathBuf, Option<PathBuf>) {
    let dir = if folder.trim().is_empty() {
        candidate_folders().into_iter().find(|d| d.join("server.py").is_file()).unwrap_or_default()
    } else {
        expand(folder)
    };
    let py = if python.trim().is_empty() { find_python(&dir) } else { Some(expand(python)) };
    (dir, py)
}

/// Where garmin-coach is, which Python runs it, whether a Garmin login is saved,
/// and whether the server is running. Empty folder/python = find them.
#[tauri::command]
pub async fn watch_status(state: tauri::State<'_, WatchState>, folder: String, python: String) -> Result<WatchStatus, String> {
    let (dir, py) = resolve(&folder, &python);
    let running = state.conn.lock().await.as_ref().map(|c| !c.service.is_closed()).unwrap_or(false);
    Ok(WatchStatus {
        folder: dir.to_string_lossy().into(),
        server_found: dir.join("server.py").is_file(),
        python: py.map(|p| p.to_string_lossy().into()),
        tokens_found: tokens_present(),
        tokens_dir: tokens_dir().to_string_lossy().into(),
        running,
        stderr: state.stderr.lock().map(|s| s.iter().cloned().collect()).unwrap_or_default(),
    })
}

async fn start(state: &WatchState, dir: &Path, py: &Path) -> Result<Conn, String> {
    if !dir.join("server.py").is_file() {
        return Err(format!("server.py isn't in {}. Set the garmin-coach folder in Settings → Watch.", dir.display()));
    }
    let mut cmd = tokio::process::Command::new(py);
    cmd.arg("server.py")
        .current_dir(dir)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        .env("GARMIN_PACE_UNIT", "km")
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window flashing up for the Python process.
        cmd.creation_flags(0x0800_0000);
    }
    let (transport, stderr) = TokioChildProcess::builder(cmd)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start {} server.py: {e}", py.display()))?;
    if let Some(err) = stderr {
        let buf = state.stderr.clone();
        if let Ok(mut b) = buf.lock() {
            b.clear();
        }
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut b) = buf.lock() {
                    b.push_back(line);
                    while b.len() > 40 {
                        b.pop_front();
                    }
                }
            }
        });
    }
    let service = tokio::time::timeout(START_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| "garmin-coach didn't answer within 45 s of starting.".to_string())?
        .map_err(|e| format!("garmin-coach started but the MCP handshake failed: {e}{}", tail(state)))?;
    let tools = service.list_all_tools().await.map_err(|e| format!("Couldn't read garmin-coach's tools: {e}"))?;
    Ok(Conn {
        key: format!("{}|{}", py.display(), dir.display()),
        service,
        tools: serde_json::to_value(tools).map_err(|e| e.to_string())?,
    })
}

fn tail(state: &WatchState) -> String {
    state
        .stderr
        .lock()
        .ok()
        .and_then(|b| b.back().cloned())
        .map(|l| format!(" ({l})"))
        .unwrap_or_default()
}

/// Starts garmin-coach (if it isn't running with these settings) and returns its
/// tools, each with its name, description and input schema.
#[tauri::command]
pub async fn watch_connect(state: tauri::State<'_, WatchState>, folder: String, python: String) -> Result<Value, String> {
    let (dir, py) = resolve(&folder, &python);
    let py = py.ok_or_else(|| {
        format!(
            "No Python with garmin-coach's packages found for {}. Create its .venv (see its README) or set the Python path in Settings → Watch.",
            dir.display()
        )
    })?;
    let key = format!("{}|{}", py.display(), dir.display());
    let mut guard = state.conn.lock().await;
    let reuse = matches!(guard.as_ref(), Some(c) if c.key == key && !c.service.is_closed());
    if !reuse {
        if let Some(old) = guard.take() {
            let _ = old.service.cancel().await;
        }
        *guard = Some(start(&state, &dir, &py).await?);
    }
    Ok(guard.as_ref().map(|c| c.tools.clone()).unwrap_or(Value::Null))
}

/// Calls one garmin-coach tool. Returns the MCP result as JSON
/// ({ content: [...], structuredContent?, isError? }).
#[tauri::command]
pub async fn watch_call(state: tauri::State<'_, WatchState>, name: String, args: Map<String, Value>) -> Result<Value, String> {
    let guard = state.conn.lock().await;
    let conn = guard.as_ref().filter(|c| !c.service.is_closed()).ok_or("garmin-coach isn't running")?;
    let req = CallToolRequestParams::new(name.clone()).with_arguments(args);
    let res = tokio::time::timeout(CALL_TIMEOUT, conn.service.call_tool(req))
        .await
        .map_err(|_| format!("{name} took longer than 90 s"))?
        .map_err(|e| format!("{name} failed: {e}{}", tail(&state)))?;
    serde_json::to_value(res).map_err(|e| e.to_string())
}

/// Stops garmin-coach (it's started again on the next call).
#[tauri::command]
pub async fn watch_disconnect(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    if let Some(c) = state.conn.lock().await.take() {
        let _ = c.service.cancel().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_venv_that_has_mcp() {
        let t = tempfile::tempdir().unwrap();
        let outer = t.path().join("garmin-coach-mcp");
        let inner = outer.join("garmin-coach-mcp");
        // An empty venv beside the folder (no packages) and the real one inside it.
        std::fs::create_dir_all(outer.join(".venv").join("Scripts")).unwrap();
        std::fs::write(outer.join(".venv").join("Scripts").join("python.exe"), "").unwrap();
        std::fs::create_dir_all(inner.join(".venv").join("Lib").join("site-packages").join("mcp")).unwrap();
        std::fs::create_dir_all(inner.join(".venv").join("Scripts")).unwrap();
        std::fs::write(inner.join(".venv").join("Scripts").join("python.exe"), "").unwrap();
        assert_eq!(find_python(&inner), Some(inner.join(".venv").join("Scripts").join("python.exe")));
        assert_eq!(find_python(&outer), None);
    }

    /// End to end against a real MCP server process (tests/fake_coach/server.py).
    /// Needs a Python with the `mcp` package: WATCH_TEST_PYTHON, else `python`.
    /// Skipped when there isn't one.
    #[test]
    fn talks_to_an_mcp_server_over_stdio() {
        let py = std::env::var("WATCH_TEST_PYTHON").unwrap_or_else(|_| "python".into());
        let has_mcp = std::process::Command::new(&py).args(["-c", "import mcp"]).status().map(|s| s.success()).unwrap_or(false);
        if !has_mcp {
            eprintln!("skipped: no Python with mcp");
            return;
        }
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fake_coach");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let state = WatchState::default();
            let conn = start(&state, &dir, Path::new(&py)).await.expect("server starts");
            let names: Vec<String> = conn.tools.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
            assert!(names.contains(&"preview_workout".to_string()), "{names:?}");
            assert!(conn.tools[0]["inputSchema"]["properties"].is_object());
            let mut args = Map::new();
            args.insert("name".into(), Value::from("Easy"));
            args.insert("steps".into(), serde_json::json!([{ "kind": "interval", "duration": "5km" }]));
            let res = conn.service.call_tool(CallToolRequestParams::new("preview_workout").with_arguments(args)).await.unwrap();
            let v = serde_json::to_value(res).unwrap();
            assert!(v.to_string().contains("Easy (running) with 1 steps"), "{v}");
            let _ = conn.service.cancel().await;
        });
    }

    #[test]
    fn expands_home() {
        let h = home();
        assert_eq!(expand("~/x"), h.join("x"));
        assert_eq!(expand("%USERPROFILE%\\x"), h.join("x"));
        assert_eq!(expand(" \"C:\\a\" "), PathBuf::from("C:\\a"));
    }
}
