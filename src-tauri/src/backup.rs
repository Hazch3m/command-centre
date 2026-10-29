//! Automatic daily backups.
//!
//! Once per calendar day the database is snapshotted (VACUUM INTO, so the copy is
//! consistent even while the app is writing) together with any JSON config files
//! into `backups/YYYY-MM-DD/`. The newest `KEEP_DAYS` folders are kept.

use crate::db::Db;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const KEEP_DAYS: usize = 30;

#[derive(Serialize)]
pub struct BackupStatus {
    pub folder: String,
    pub latest: Option<String>,
    pub count: usize,
}

fn backup_root(data_dir: &Path) -> PathBuf {
    data_dir.join("backups")
}

fn list_backups(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().to_str().map(String::from))
                // Only folders we created: YYYY-MM-DD
                .filter(|n| n.len() == 10 && chrono::NaiveDate::parse_from_str(n, "%Y-%m-%d").is_ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Creates today's backup if it doesn't exist yet. Returns the folder when one was made.
/// `force` replaces today's backup (used by the "Back up now" button).
pub fn ensure_daily_backup(db: &Db, data_dir: &Path, today: &str, force: bool) -> Result<Option<PathBuf>, String> {
    let root = backup_root(data_dir);
    let folder = root.join(today);
    if folder.exists() {
        if !force {
            return Ok(None);
        }
        fs::remove_dir_all(&folder).map_err(|e| e.to_string())?;
    }
    // Write into a temp folder first so a crash never leaves a half-made backup that blocks the day.
    let tmp = root.join(format!(".{today}.partial"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let db_name = db.path.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "data.db".into());
    db.snapshot_to(&tmp.join(&db_name)).map_err(|e| e.to_string())?;

    if let Ok(entries) = fs::read_dir(data_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_file() && p.extension().map(|x| x == "json").unwrap_or(false) {
                let _ = fs::copy(&p, tmp.join(e.file_name()));
            }
        }
    }
    fs::rename(&tmp, &folder).map_err(|e| e.to_string())?;

    let all = list_backups(&root);
    if all.len() > KEEP_DAYS {
        for old in &all[..all.len() - KEEP_DAYS] {
            let _ = fs::remove_dir_all(root.join(old));
        }
    }
    Ok(Some(folder))
}

pub fn status(data_dir: &Path) -> BackupStatus {
    let root = backup_root(data_dir);
    let all = list_backups(&root);
    BackupStatus { folder: root.to_string_lossy().into(), latest: all.last().cloned(), count: all.len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_backup_and_pruning() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let db = Db::open(&data.join("command-centre.db")).unwrap();
        fs::write(data.join("config.json"), "{}").unwrap();

        for d in 1..=35 {
            let day = format!("2026-10-{:02}", d.min(31));
            let day = if d > 31 { format!("2026-11-{:02}", d - 31) } else { day };
            ensure_daily_backup(&db, data, &day, false).unwrap();
        }
        let s = status(data);
        assert_eq!(s.count, KEEP_DAYS);
        assert_eq!(s.latest.as_deref(), Some("2026-11-04"));
        let latest = backup_root(data).join("2026-11-04");
        assert!(latest.join("command-centre.db").exists());
        assert!(latest.join("config.json").exists());
        // Second call on the same day is a no-op; forced call replaces it.
        assert!(ensure_daily_backup(&db, data, "2026-11-04", false).unwrap().is_none());
        assert!(ensure_daily_backup(&db, data, "2026-11-04", true).unwrap().is_some());
    }
}
