//! Sign-in to Strava and Google, and authenticated API calls.
//!
//! Client IDs, secrets and tokens live only in Windows Credential Manager
//! (service "CommandCentre"); they never reach the web page. The page asks the
//! backend to make a request; the backend adds the token (refreshing it when
//! needed) and only talks to the provider's own API hosts.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SERVICE: &str = "CommandCentre";

pub struct Provider {
    pub id: &'static str,
    auth_url: &'static str,
    token_url: &'static str,
    scopes: &'static str,
    extra_auth: &'static [(&'static str, &'static str)],
    pkce: bool,
    /// Only URLs starting with one of these may be requested with this provider's token.
    api_prefixes: &'static [&'static str],
}

const PROVIDERS: &[Provider] = &[
    Provider {
        id: "strava",
        auth_url: "https://www.strava.com/oauth/authorize",
        token_url: "https://www.strava.com/oauth/token",
        scopes: "read,activity:read_all",
        extra_auth: &[("approval_prompt", "auto")],
        pkce: false,
        api_prefixes: &["https://www.strava.com/api/v3/"],
    },
    Provider {
        id: "google",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks",
        extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
        pkce: true,
        api_prefixes: &["https://www.googleapis.com/calendar/v3/", "https://tasks.googleapis.com/tasks/v1/", "https://www.googleapis.com/tasks/v1/"],
    },
];

fn provider(id: &str) -> Result<&'static Provider, String> {
    PROVIDERS.iter().find(|p| p.id == id).ok_or_else(|| format!("Unknown service \"{id}\""))
}

// ---- Credential storage ----------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct Client {
    id: String,
    secret: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Token {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds
    expires_at: u64,
    #[serde(default)]
    account: Option<String>,
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// Windows Credential Manager holds at most 2,560 bytes per entry (1,280 UTF-16
/// characters), and Garmin's tokens are longer, so long values are split
/// across numbered entries: "key" holds "chunked:N", the parts "key#0"…"key#N-1".
const CHUNK: usize = 1000;
const CHUNKED: &str = "chunked:";

fn read_raw(key: &str) -> Option<String> {
    let head = entry(key).ok()?.get_password().ok()?;
    match head.strip_prefix(CHUNKED).and_then(|n| n.parse::<usize>().ok()) {
        Some(n) => {
            let mut out = String::new();
            for i in 0..n {
                out.push_str(&entry(&format!("{key}#{i}")).ok()?.get_password().ok()?);
            }
            Some(out)
        }
        None => Some(head),
    }
}

pub(crate) fn load<T: for<'de> Deserialize<'de>>(key: &str) -> Option<T> {
    read_raw(key).and_then(|s| serde_json::from_str(&s).ok())
}

/// Splits on character boundaries (the JSON may contain non-ASCII text).
pub(crate) fn chunks(s: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    chars.chunks(size).map(|c| c.iter().collect()).collect()
}

pub(crate) fn save<T: Serialize>(key: &str, v: &T) -> Result<(), String> {
    let text = serde_json::to_string(v).map_err(|e| e.to_string())?;
    forget(key);
    if text.chars().count() <= CHUNK {
        return entry(key)?.set_password(&text).map_err(|e| e.to_string());
    }
    let parts = chunks(&text, CHUNK);
    for (i, part) in parts.iter().enumerate() {
        entry(&format!("{key}#{i}"))?.set_password(part).map_err(|e| e.to_string())?;
    }
    entry(key)?.set_password(&format!("{CHUNKED}{}", parts.len())).map_err(|e| e.to_string())
}

pub(crate) fn forget(key: &str) {
    if let Ok(e) = entry(key) {
        if let Ok(head) = e.get_password() {
            if let Some(n) = head.strip_prefix(CHUNKED).and_then(|n| n.parse::<usize>().ok()) {
                for i in 0..n {
                    if let Ok(p) = entry(&format!("{key}#{i}")) {
                        let _ = p.delete_credential();
                    }
                }
            }
        }
        let _ = e.delete_credential();
    }
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random(n: usize) -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(n).map(char::from).collect()
}

// ---- Commands --------------------------------------------------------------

#[derive(Serialize)]
pub struct Status {
    configured: bool,
    connected: bool,
    account: Option<String>,
}

#[tauri::command]
pub fn oauth_status(provider_id: String) -> Result<Status, String> {
    let p = provider(&provider_id)?;
    let token: Option<Token> = load(&format!("{}.token", p.id));
    Ok(Status {
        configured: load::<Client>(&format!("{}.client", p.id)).is_some(),
        connected: token.is_some(),
        account: token.and_then(|t| t.account),
    })
}

#[tauri::command]
pub fn oauth_set_client(provider_id: String, client_id: String, client_secret: String) -> Result<(), String> {
    let p = provider(&provider_id)?;
    let (id, secret) = (client_id.trim().to_string(), client_secret.trim().to_string());
    if id.is_empty() || secret.is_empty() {
        return Err("Enter both the client ID and the client secret.".into());
    }
    save(&format!("{}.client", p.id), &Client { id, secret })?;
    // New app credentials invalidate any old sign-in.
    forget(&format!("{}.token", p.id));
    Ok(())
}

#[tauri::command]
pub fn oauth_disconnect(provider_id: String, forget_client: bool) -> Result<(), String> {
    let p = provider(&provider_id)?;
    forget(&format!("{}.token", p.id));
    if forget_client {
        forget(&format!("{}.client", p.id));
    }
    Ok(())
}

/// Opens the browser for sign-in and waits (up to 5 minutes) for the redirect.
#[tauri::command]
pub async fn oauth_connect(app: AppHandle, http: tauri::State<'_, reqwest::Client>, provider_id: String) -> Result<Status, String> {
    let p = provider(&provider_id)?;
    let client: Client = load(&format!("{}.client", p.id)).ok_or("Enter the client ID and secret first.")?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let state = random(24);
    let verifier = random(64);

    let mut url = url::Url::parse(p.auth_url).map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &client.id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", p.scopes)
            .append_pair("state", &state);
        for (k, v) in p.extra_auth {
            q.append_pair(k, v);
        }
        if p.pkce {
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            q.append_pair("code_challenge", &challenge).append_pair("code_challenge_method", "S256");
        }
    }
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    let code = tokio::time::timeout(Duration::from_secs(300), wait_for_code(listener, &state))
        .await
        .map_err(|_| "Sign-in timed out after 5 minutes. Try again.".to_string())??;

    let mut form = vec![
        ("client_id", client.id.clone()),
        ("client_secret", client.secret.clone()),
        ("code", code),
        ("grant_type", "authorization_code".into()),
        ("redirect_uri", redirect),
    ];
    if p.pkce {
        form.push(("code_verifier", verifier));
    }
    let resp: Value = http.post(p.token_url).form(&form).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let mut token = parse_token(&resp, None)?;
    token.account = match p.id {
        "strava" => resp["athlete"]["firstname"].as_str().map(|f| format!("{} {}", f, resp["athlete"]["lastname"].as_str().unwrap_or("")).trim().to_string()),
        _ => None,
    };
    save(&format!("{}.token", p.id), &token)?;
    if p.id == "google" {
        // The primary calendar's id is the account's email address.
        if let Ok(v) = request_inner(&http, p, "GET", "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary", None).await {
            if let Some(email) = v.1["id"].as_str() {
                token.account = Some(email.to_string());
                save(&format!("{}.token", p.id), &token)?;
            }
        }
    }
    oauth_status(provider_id)
}

async fn wait_for_code(listener: tokio::net::TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let path = req.split_whitespace().nth(1).unwrap_or("/");
        if !path.starts_with("/callback") {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            continue;
        }
        let url = url::Url::parse(&format!("http://localhost{path}")).map_err(|e| e.to_string())?;
        let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
        let (ok, msg, result) = match (get("state"), get("code"), get("error")) {
            (_, _, Some(err)) => (false, "Sign-in was cancelled. You can close this tab.", Err(format!("Sign-in was refused ({err}).")),),
            (Some(s), Some(code), None) if s == state => (true, "Connected to Command Centre. You can close this tab.", Ok(code)),
            _ => (false, "Something went wrong. Close this tab and try again.", Err("Sign-in reply didn't match; please try again.".to_string())),
        };
        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Command Centre</title><body style=\"font:20px system-ui;background:#0a0c0f;color:{};display:grid;place-items:center;height:90vh\">{}</body>",
            if ok { "#5ad6a8" } else { "#ff6b6b" },
            msg
        );
        let _ = sock
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes())
            .await;
        return result;
    }
}

fn parse_token(resp: &Value, old_refresh: Option<String>) -> Result<Token, String> {
    let access = resp["access_token"].as_str().ok_or_else(|| {
        let why = resp["error_description"].as_str().or(resp["message"].as_str()).or(resp["error"].as_str()).unwrap_or("no access token returned");
        format!("The service refused the sign-in: {why}")
    })?;
    let expires_at = resp["expires_at"].as_u64().unwrap_or_else(|| now() + resp["expires_in"].as_u64().unwrap_or(3600));
    Ok(Token {
        access_token: access.into(),
        refresh_token: resp["refresh_token"].as_str().map(String::from).or(old_refresh),
        expires_at,
        account: None,
    })
}

async fn valid_token(http: &reqwest::Client, p: &Provider, force_refresh: bool) -> Result<String, String> {
    let key = format!("{}.token", p.id);
    let mut token: Token = load(&key).ok_or("Not connected. Connect it in Settings.")?;
    if force_refresh || token.expires_at <= now() + 60 {
        let client: Client = load(&format!("{}.client", p.id)).ok_or("Enter the client ID and secret first.")?;
        let refresh = token.refresh_token.clone().ok_or("Sign-in expired. Reconnect it in Settings.")?;
        let resp: Value = http
            .post(p.token_url)
            .form(&[("client_id", client.id.as_str()), ("client_secret", client.secret.as_str()), ("grant_type", "refresh_token"), ("refresh_token", refresh.as_str())])
            .send()
            .await
            .map_err(|e| format!("offline: {e}"))?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if resp["error"].as_str() == Some("invalid_grant") {
            forget(&key);
            return Err("Sign-in expired or was revoked. Reconnect it in Settings.".into());
        }
        let account = token.account.clone();
        token = parse_token(&resp, token.refresh_token)?;
        token.account = account;
        save(&key, &token)?;
    }
    Ok(token.access_token)
}

async fn request_inner(http: &reqwest::Client, p: &Provider, method: &str, url: &str, body: Option<Value>) -> Result<(u16, Value), String> {
    if !p.api_prefixes.iter().any(|pre| url.starts_with(pre)) {
        return Err(format!("{url} is not an allowed {} address", p.id));
    }
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut retried = false;
    loop {
        let token = valid_token(http, p, retried).await?;
        let mut req = http.request(m.clone(), url).bearer_auth(&token).timeout(Duration::from_secs(30));
        if let Some(b) = &body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| format!("offline: {e}"))?;
        let status = resp.status().as_u16();
        if status == 401 && !retried {
            retried = true;
            continue;
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let json = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) };
        return Ok((status, json));
    }
}

#[derive(Serialize)]
pub struct ApiResponse {
    status: u16,
    body: Value,
}

/// Authenticated request to Strava or Google. Network failures come back as an
/// error starting with "offline:" so the page can fall back to cached data.
#[tauri::command]
pub async fn api_request(
    http: tauri::State<'_, reqwest::Client>,
    provider_id: String,
    method: String,
    url: String,
    body: Option<Value>,
) -> Result<ApiResponse, String> {
    let p = provider(&provider_id)?;
    let (status, body) = request_inner(&http, p, &method, &url, body).await?;
    Ok(ApiResponse { status, body })
}

// ---- Calendar feeds (secret iCal links) -------------------------------------
//
// The simplest way to show a Google (or Outlook/iCloud) calendar: its private
// iCal address. The address works like a password, so it's kept in the
// keychain and fetched here; the page only sees the calendar text.

const ICS_KEY: &str = "ics.feeds";

#[derive(Serialize, Deserialize, Clone)]
pub struct IcsFeed {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct IcsFeedInfo {
    id: String,
    name: String,
    host: String,
}

/// webcal:// → https://, and only https feeds are accepted.
pub fn normalise_ics_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let t = if let Some(rest) = t.strip_prefix("webcal://") { format!("https://{rest}") } else { t.to_string() };
    let u = url::Url::parse(&t).map_err(|_| "That doesn't look like a web address.".to_string())?;
    if u.scheme() != "https" || u.host_str().is_none() {
        return Err("The calendar address must start with https:// (or webcal://).".into());
    }
    Ok(u.to_string())
}

fn ics_feeds() -> Vec<IcsFeed> {
    load(ICS_KEY).unwrap_or_default()
}

#[tauri::command]
pub fn ics_list() -> Vec<IcsFeedInfo> {
    ics_feeds()
        .into_iter()
        .map(|f| IcsFeedInfo {
            host: url::Url::parse(&f.url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default(),
            id: f.id,
            name: f.name,
        })
        .collect()
}

#[tauri::command]
pub fn ics_add(name: String, url: String) -> Result<(), String> {
    let url = normalise_ics_url(&url)?;
    let mut feeds = ics_feeds();
    if feeds.iter().any(|f| f.url == url) {
        return Err("That calendar is already added.".into());
    }
    let name = if name.trim().is_empty() { format!("Calendar {}", feeds.len() + 1) } else { name.trim().to_string() };
    feeds.push(IcsFeed { id: random(10), name, url });
    save(ICS_KEY, &feeds)
}

#[tauri::command]
pub fn ics_remove(id: String) -> Result<(), String> {
    let feeds: Vec<IcsFeed> = ics_feeds().into_iter().filter(|f| f.id != id).collect();
    if feeds.is_empty() {
        forget(ICS_KEY);
        Ok(())
    } else {
        save(ICS_KEY, &feeds)
    }
}

/// Downloads one feed. Network failures start with "offline:".
#[tauri::command]
pub async fn ics_fetch(http: tauri::State<'_, reqwest::Client>, id: String) -> Result<String, String> {
    let feed = ics_feeds().into_iter().find(|f| f.id == id).ok_or("That calendar was removed.")?;
    let resp = http.get(&feed.url).timeout(Duration::from_secs(30)).send().await.map_err(|e| format!("offline: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(if status.as_u16() == 404 || status.as_u16() == 403 {
            "The calendar address was refused. If you reset the secret address in Google Calendar, add the new one.".into()
        } else {
            format!("The calendar server replied {status}")
        });
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("That address didn't return a calendar. Use the \"Secret address in iCal format\".".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_long_values_on_character_boundaries() {
        let s = "é".repeat(2500);
        let parts = chunks(&s, 1000);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.concat(), s);
        assert!(parts.iter().all(|p| p.encode_utf16().count() * 2 <= 2560));
    }

    #[test]
    fn normalises_calendar_addresses() {
        assert_eq!(normalise_ics_url(" webcal://p01-calendars.icloud.com/x ").unwrap(), "https://p01-calendars.icloud.com/x");
        assert!(normalise_ics_url("http://example.com/a.ics").is_err());
        assert!(normalise_ics_url("not a url").is_err());
    }

    #[test]
    fn providers_are_locked_to_their_hosts() {
        let s = provider("strava").unwrap();
        assert!(s.api_prefixes.iter().all(|p| p.starts_with("https://www.strava.com/")));
        let g = provider("google").unwrap();
        assert!(g.scopes.contains("calendar.readonly") && g.scopes.contains("/auth/tasks"));
        assert!(provider("evil").is_err());
    }

    #[test]
    fn parses_tokens_from_both_shapes() {
        let strava = serde_json::json!({"access_token":"a","refresh_token":"r","expires_at": 2000000000u64});
        let t = parse_token(&strava, None).unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref(), t.expires_at), ("a", Some("r"), 2000000000));
        // Google refreshes don't resend the refresh token; keep the old one.
        let google = serde_json::json!({"access_token":"b","expires_in": 3599});
        let t = parse_token(&google, Some("old".into())).unwrap();
        assert_eq!(t.refresh_token.as_deref(), Some("old"));
        assert!(t.expires_at > now());
        // Token deliberately has no Debug impl (so it can never be logged); match instead of unwrap_err.
        match parse_token(&serde_json::json!({"error":"invalid_grant","error_description":"Bad Request"}), None) {
            Err(msg) => assert!(msg.contains("Bad Request")),
            Ok(_) => panic!("an error reply must not parse as a token"),
        }
    }
}
