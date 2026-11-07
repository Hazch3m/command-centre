//! Garmin Connect, for health metrics (VO2 max, HRV, sleep, resting heart rate,
//! Body Battery, training readiness, race predictions) and runs.
//!
//! Garmin has no public API for personal use, so this does what Garmin's own
//! app does. You sign in on Garmin's real sign-in page, in a separate window
//! (password and two-step code go straight to Garmin; the app never sees them).
//! When Garmin hands back a one-time "service ticket", the app swaps it for an
//! access token and a refresh token, kept in Windows Credential Manager.
//! The page only gets read access to a fixed set of health endpoints.

use crate::oauth::{forget, load, now, save};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

const KEY: &str = "garmin.token";
const LOGIN_LABEL: &str = "garmin-login";
const SERVICE_URL: &str = "https://connect.garmin.com/app";
const SIGN_IN_URL: &str = "https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";
const DI_TOKEN_URL: &str = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const DI_GRANT_TYPE: &str = "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
const DI_CLIENT_IDS: &[&str] = &[
    "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
    "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
    "GARMIN_CONNECT_MOBILE_ANDROID_DI",
    "GARMIN_CONNECT_MOBILE_IOS_DI",
];
const API: &str = "https://connectapi.garmin.com";
/// Read-only health and profile services the page may ask for.
const ALLOWED: &[&str] = &[
    "/metrics-service/",
    "/hrv-service/",
    "/wellness-service/",
    "/sleep-service/",
    "/userstats-service/",
    "/usersummary-service/",
    "/userprofile-service/",
    // Runs: the activity list, and one run's samples and laps.
    "/activitylist-service/activities/search/activities",
    "/activity-service/activity/",
    // Workouts on your watch: what's scheduled, and one workout's steps.
    "/calendar-service/year/",
    "/workout-service/workout/",
];

/// Where the app may write: creating, changing, scheduling and removing workouts (nothing else).
const WRITE_ALLOWED: &[&str] = &["/workout-service/workout", "/workout-service/schedule/", "/activity-service/activity/"];

#[derive(Serialize, Deserialize, Clone)]
struct GToken {
    access: String,
    refresh: Option<String>,
    client_id: String,
    /// Unix seconds
    expires_at: u64,
}

#[derive(Serialize)]
pub struct GarminStatus {
    connected: bool,
}

#[derive(Serialize)]
pub struct GarminResponse {
    status: u16,
    body: Value,
}

/// Headers Garmin's Android app sends; the token service and API expect them.
fn native(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header("User-Agent", "GCM-Android-5.23")
        .header(
            "X-Garmin-User-Agent",
            "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
        )
        .header("X-Garmin-Paired-App-Version", "10861")
        .header("X-Garmin-Client-Platform", "Android")
        .header("X-App-Ver", "10861")
        .header("X-Lang", "en")
        .header("X-GCExperience", "GC5")
        .header("Accept-Language", "en-US,en;q=0.9")
}

fn basic(client_id: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{client_id}:")))
}

/// The ticket Garmin appends when sign-in finishes: connect.garmin.com/app?ticket=ST-…
pub fn ticket_from(url: &Url) -> Option<String> {
    if url.host_str() != Some("connect.garmin.com") {
        return None;
    }
    url.query_pairs().find(|(k, _)| k == "ticket").map(|(_, v)| v.into_owned()).filter(|t| t.starts_with("ST-"))
}

fn parse_token(v: &Value, client_id: &str, old_refresh: Option<String>) -> Result<GToken, String> {
    let access = v.get("access_token").and_then(Value::as_str).ok_or("Garmin didn't return an access token")?;
    let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    Ok(GToken {
        access: access.to_string(),
        // The refresh token rotates; keep the old one if a reply leaves it out.
        refresh: v.get("refresh_token").and_then(Value::as_str).map(String::from).or(old_refresh),
        client_id: client_id.to_string(),
        expires_at: now() + expires_in,
    })
}

async fn exchange(http: &reqwest::Client, ticket: &str) -> Result<GToken, String> {
    let mut last = String::new();
    for id in DI_CLIENT_IDS {
        let resp = native(http.post(DI_TOKEN_URL))
            .header("Authorization", basic(id))
            .header("Accept", "application/json,text/html;q=0.9,*/*;q=0.8")
            .header("Cache-Control", "no-cache")
            .form(&[("client_id", *id), ("service_ticket", ticket), ("grant_type", DI_GRANT_TYPE), ("service_url", SERVICE_URL)])
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("offline: {e}"))?;
        let status = resp.status().as_u16();
        if status == 429 {
            return Err("Garmin is limiting sign-ins right now. Try again in an hour.".into());
        }
        if !(200..300).contains(&status) {
            last = format!("HTTP {status}");
            continue;
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Ok(t) = parse_token(&v, id, None) {
            return Ok(t);
        }
    }
    Err(format!("Garmin didn't accept the sign-in ({last}). Try again; if it keeps failing, Garmin may have changed its sign-in."))
}

async fn refresh(http: &reqwest::Client, t: &GToken) -> Result<GToken, String> {
    let rt = t.refresh.clone().ok_or("Garmin sign-in expired. Connect again in Settings.")?;
    let resp = native(http.post(DI_TOKEN_URL))
        .header("Authorization", basic(&t.client_id))
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache")
        .form(&[("grant_type", "refresh_token"), ("client_id", t.client_id.as_str()), ("refresh_token", rt.as_str())])
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("offline: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        if status == 400 || status == 401 {
            forget(KEY);
            return Err("Garmin sign-in expired. Connect again in Settings.".into());
        }
        return Err(format!("Garmin token refresh failed (HTTP {status})"));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let nt = parse_token(&v, &t.client_id, Some(rt))?;
    save(KEY, &nt)?;
    Ok(nt)
}

#[tauri::command]
pub fn garmin_status() -> GarminStatus {
    GarminStatus { connected: load::<GToken>(KEY).is_some() }
}

#[tauri::command]
pub fn garmin_disconnect() {
    forget(KEY);
}

/// Opens Garmin's sign-in page in its own window and waits for the sign-in to finish.
#[tauri::command]
pub async fn garmin_connect(app: AppHandle, http: tauri::State<'_, reqwest::Client>) -> Result<GarminStatus, String> {
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.destroy();
    }
    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let tx_nav = tx.clone();
    let url = Url::parse(SIGN_IN_URL).map_err(|e| e.to_string())?;
    let win = WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Sign in to Garmin Connect")
        .inner_size(520.0, 780.0)
        .center()
        .focused(true)
        .on_navigation(move |u| {
            if let Some(t) = ticket_from(u) {
                if let Some(s) = tx_nav.lock().ok().and_then(|mut g| g.take()) {
                    let _ = s.send(Ok(t));
                }
                return false; // don't load Garmin Connect itself
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;
    let tx_close = tx.clone();
    win.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            if let Some(s) = tx_close.lock().ok().and_then(|mut g| g.take()) {
                let _ = s.send(Err("Sign-in window closed before finishing.".into()));
            }
        }
    });
    let result = tokio::time::timeout(Duration::from_secs(900), rx).await;
    let _ = win.destroy();
    let ticket = match result {
        Ok(Ok(r)) => r?,
        Ok(Err(_)) => return Err("Sign-in was interrupted.".into()),
        Err(_) => return Err("Sign-in timed out.".into()),
    };
    let token = exchange(&http, &ticket).await?;
    save(KEY, &token)?;
    Ok(GarminStatus { connected: true })
}

/// GET a Garmin Connect health endpoint. Network failures start with "offline:".
#[tauri::command]
pub async fn garmin_request(http: tauri::State<'_, reqwest::Client>, path: String) -> Result<GarminResponse, String> {
    if !path.starts_with('/') || path.contains("..") || path.contains("://") || !ALLOWED.iter().any(|p| path.starts_with(p)) {
        return Err(format!("{path} is not an allowed Garmin address"));
    }
    let mut token: GToken = load(KEY).ok_or("Garmin isn't connected")?;
    if token.expires_at <= now() + 600 {
        token = refresh(&http, &token).await?;
    }
    let mut retried = false;
    loop {
        let resp = native(http.get(format!("{API}{path}")))
            .bearer_auth(&token.access)
            .header("Accept", "application/json")
            .header("NK", "NT")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("offline: {e}"))?;
        let status = resp.status().as_u16();
        if status == 401 && !retried {
            retried = true;
            token = refresh(&http, &token).await?;
            continue;
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let body = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) };
        return Ok(GarminResponse { status, body });
    }
}

/// POST, PUT or DELETE on Garmin's workout service: puts plan sessions on your watch.
#[tauri::command]
pub async fn garmin_write(http: tauri::State<'_, reqwest::Client>, method: String, path: String, body: Option<Value>) -> Result<GarminResponse, String> {
    let m = match method.as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Only POST, PUT and DELETE".into()),
    };
    // Activities may only be renamed or described (PUT), never deleted.
    if path.starts_with("/activity-service/") && method != "PUT" {
        return Err("Activities can only be updated".into());
    }
    if !path.starts_with('/') || path.contains("..") || path.contains("://") || path.contains('?') || !WRITE_ALLOWED.iter().any(|p| path.starts_with(p)) {
        return Err(format!("{path} is not an allowed Garmin address"));
    }
    let mut token: GToken = load(KEY).ok_or("Garmin isn't connected")?;
    if token.expires_at <= now() + 600 {
        token = refresh(&http, &token).await?;
    }
    let mut retried = false;
    loop {
        let mut req = native(http.request(m.clone(), format!("{API}{path}")))
            .bearer_auth(&token.access)
            .header("Accept", "application/json")
            .header("NK", "NT")
            .timeout(Duration::from_secs(30));
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| format!("offline: {e}"))?;
        let status = resp.status().as_u16();
        if status == 401 && !retried {
            retried = true;
            token = refresh(&http, &token).await?;
            continue;
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let body = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        return Ok(GarminResponse { status, body });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_ticket_only_on_garmin_connect() {
        let u = Url::parse("https://connect.garmin.com/app?ticket=ST-123-abc").unwrap();
        assert_eq!(ticket_from(&u).as_deref(), Some("ST-123-abc"));
        assert!(ticket_from(&Url::parse("https://evil.example/app?ticket=ST-1").unwrap()).is_none());
        assert!(ticket_from(&Url::parse("https://connect.garmin.com/app").unwrap()).is_none());
    }

    #[test]
    fn reads_and_rotates_tokens() {
        let v = serde_json::json!({"access_token":"a","refresh_token":"r","expires_in":89604});
        let t = parse_token(&v, "X", None).unwrap();
        assert_eq!((t.access.as_str(), t.refresh.as_deref()), ("a", Some("r")));
        let t2 = parse_token(&serde_json::json!({"access_token":"b","expires_in":10}), "X", Some("r".into())).unwrap();
        assert_eq!(t2.refresh.as_deref(), Some("r"));
    }
}
