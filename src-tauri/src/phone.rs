//! Phone link: a copy of the database for the phone, and the link's details in the keychain.
//!
//! The copy is made with VACUUM INTO (consistent while the app writes), then the
//! big second-by-second run streams are dropped, since the phone fetches nothing
//! itself. It's encrypted in the frontend before it leaves the PC; no sign-in
//! tokens are in the database (they live in the keychain), so none reach the phone.

use crate::db::Db;
use crate::oauth;
use crate::DataDir;
use serde::{Deserialize, Serialize};
use std::fs;

const KEY: &str = "phone.link";

#[derive(Serialize, Deserialize, Clone)]
pub struct PhoneLink {
    /// The sync service's address, e.g. https://command-centre-sync.you.workers.dev
    pub url: String,
    /// 32 random bytes (base64url). Encryption key and access token are derived from it.
    pub secret: String,
}

#[tauri::command]
pub fn phone_link_get() -> Option<PhoneLink> {
    oauth::load::<PhoneLink>(KEY)
}

#[tauri::command]
pub fn phone_link_set(link: Option<PhoneLink>) -> Result<(), String> {
    match link {
        Some(l) => {
            if !l.url.starts_with("https://") {
                return Err("The sync address must start with https://".into());
            }
            oauth::save(KEY, &l)
        }
        None => {
            oauth::forget(KEY);
            Ok(())
        }
    }
}

// ---- Sync in the cloud ----------------------------------------------------------------
//
// With cloud sync on, the sync service fetches Garmin and calendar data itself,
// so the phone stays up to date with the PC off. That needs the sign-ins, so the
// PC hands them over (only to its own linked service, over HTTPS), and takes the
// Garmin one back when cloud sync is switched off: Garmin's refresh token
// rotates, so only one place may use it at a time.

/// The sign-ins the cloud needs: Garmin's token, Google's client and token, the calendar feeds.
#[tauri::command]
pub fn cloud_credentials() -> serde_json::Value {
    let garmin: Option<serde_json::Value> = oauth::load("garmin.token");
    let client: Option<serde_json::Value> = oauth::load("google.client");
    let token: Option<serde_json::Value> = oauth::load("google.token");
    let ics: Option<serde_json::Value> = oauth::load("ics.feeds");
    serde_json::json!({
        "garmin": garmin,
        "google": match (client, token) { (Some(c), Some(t)) => serde_json::json!({ "client": c, "token": t }), _ => serde_json::Value::Null },
        "ics": ics.unwrap_or(serde_json::json!([])),
    })
}

/// Takes the sign-ins back from the cloud (the Garmin one may have been refreshed there).
#[tauri::command]
pub fn cloud_restore(garmin: Option<serde_json::Value>, google: Option<serde_json::Value>) -> Result<(), String> {
    if let Some(g) = garmin.filter(|v| v.get("access").and_then(|a| a.as_str()).is_some()) {
        oauth::save("garmin.token", &g)?;
    }
    if let Some(t) = google.filter(|v| v.get("access_token").and_then(|a| a.as_str()).is_some()) {
        oauth::save("google.token", &t)?;
    }
    Ok(())
}

/// Tables the phone has no use for (large, or only meaningful on this PC).
const DROP_ROWS: &[&str] = &["strava_full"];

fn make_snapshot(db: &Db, dir: &std::path::Path) -> Result<Vec<u8>, String> {
    let tmp = dir.join(".phone-snapshot.db");
    let _ = fs::remove_file(&tmp);
    db.snapshot_to(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let conn = rusqlite::Connection::open(&tmp).map_err(|e| e.to_string())?;
        for t in DROP_ROWS {
            let exists: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [t], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if exists > 0 {
                conn.execute(&format!("DELETE FROM {t}"), []).map_err(|e| e.to_string())?;
            }
        }
        conn.execute_batch("VACUUM;").map_err(|e| e.to_string())?;
        drop(conn);
        fs::read(&tmp).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&tmp);
    result
}

/// The database as bytes, for the phone.
#[tauri::command]
pub fn phone_snapshot(db: tauri::State<Db>, dir: tauri::State<DataDir>) -> Result<tauri::ipc::Response, String> {
    make_snapshot(&db, &dir.0).map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_drops_streams_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("a.db")).unwrap();
        db.execute("CREATE TABLE strava_full (id TEXT, json TEXT)", &[]).unwrap();
        db.execute("INSERT INTO strava_full VALUES ('1', ?1)", &[json!("x".repeat(10_000))]).unwrap();
        db.execute("INSERT INTO kv (key, value) VALUES ('a', '1')", &[]).unwrap();
        let bytes = make_snapshot(&db, dir.path()).unwrap();
        assert_eq!(&bytes[..16], b"SQLite format 3\0");
        let copy = dir.path().join("copy.db");
        fs::write(&copy, &bytes).unwrap();
        let c = rusqlite::Connection::open(&copy).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM strava_full", [], |r| r.get(0)).unwrap();
        let v: String = c.query_row("SELECT value FROM kv WHERE key = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert_eq!(v, "1");
        assert!(!dir.path().join(".phone-snapshot.db").exists());
    }
}
