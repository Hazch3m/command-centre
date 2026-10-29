//! Local SQLite storage.
//!
//! The frontend owns its schema: each card ships its own migrations, which are
//! run through `db_batch`. This file only provides a single shared connection
//! and safe JSON <-> SQLite conversion. All queries use bound parameters.

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value as Json};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub struct Db {
    conn: Mutex<Connection>,
    pub path: PathBuf,
}

#[derive(Debug, Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Json>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ExecResult {
    pub changes: usize,
    #[serde(rename = "lastInsertId")]
    pub last_insert_id: i64,
}

fn to_sql(v: &Json) -> SqlValue {
    match v {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::Integer(*b as i64),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn to_json(v: ValueRef) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Json::Array(b.iter().map(|x| Json::Number((*x).into())).collect()),
    }
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
        )?;
        Ok(Db { conn: Mutex::new(conn), path: path.to_path_buf() })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock must not brick the dashboard for the day.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn select(&self, sql: &str, params: &[Json]) -> rusqlite::Result<Vec<Map<String, Json>>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(sql)?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut rows = stmt.query(params_from_iter(params.iter().map(to_sql)))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut obj = Map::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                obj.insert(name.clone(), to_json(row.get_ref(i)?));
            }
            out.push(obj);
        }
        Ok(out)
    }

    pub fn execute(&self, sql: &str, params: &[Json]) -> rusqlite::Result<ExecResult> {
        let conn = self.lock();
        let changes = conn.prepare_cached(sql)?.execute(params_from_iter(params.iter().map(to_sql)))?;
        Ok(ExecResult { changes, last_insert_id: conn.last_insert_rowid() })
    }

    /// Runs several statements in one transaction: all succeed or none do.
    /// A statement with no params may contain several `;`-separated commands (used by migrations).
    pub fn batch(&self, statements: &[Statement]) -> rusqlite::Result<Vec<ExecResult>> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let mut results = Vec::with_capacity(statements.len());
        for s in statements {
            if s.params.is_empty() && s.sql.trim_end().trim_end_matches(';').contains(';') {
                tx.execute_batch(&s.sql)?;
                results.push(ExecResult { changes: tx.changes() as usize, last_insert_id: tx.last_insert_rowid() });
            } else {
                let changes = tx.execute(&s.sql, params_from_iter(s.params.iter().map(to_sql)))?;
                results.push(ExecResult { changes, last_insert_id: tx.last_insert_rowid() });
            }
        }
        tx.commit()?;
        Ok(results)
    }

    /// Writes a consistent copy of the live database to `target` (which must not exist).
    pub fn snapshot_to(&self, target: &Path) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_and_transactions() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        db.batch(&[Statement {
            sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b REAL, c INTEGER); CREATE INDEX t_a ON t(a);".into(),
            params: vec![],
        }])
        .unwrap();
        let r = db.execute("INSERT INTO t (a, b, c) VALUES (?, ?, ?)", &[json!("x"), json!(1.5), json!(true)]).unwrap();
        assert_eq!(r, ExecResult { changes: 1, last_insert_id: 1 });
        let rows = db.select("SELECT * FROM t WHERE a = ?", &[json!("x")]).unwrap();
        assert_eq!(rows[0]["b"], json!(1.5));
        assert_eq!(rows[0]["c"], json!(1));

        // A failing statement rolls back the whole batch.
        let bad = db.batch(&[
            Statement { sql: "INSERT INTO t (a) VALUES ('y')".into(), params: vec![] },
            Statement { sql: "INSERT INTO nope VALUES (1)".into(), params: vec![] },
        ]);
        assert!(bad.is_err());
        assert_eq!(db.select("SELECT count(*) AS n FROM t", &[]).unwrap()[0]["n"], json!(1));

        let snap = dir.path().join("snap.db");
        db.snapshot_to(&snap).unwrap();
        let copy = Db::open(&snap).unwrap();
        assert_eq!(copy.select("SELECT a FROM t", &[]).unwrap()[0]["a"], json!("x"));
    }
}
