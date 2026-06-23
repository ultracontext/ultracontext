//! FTS5-backed full-text indexing and hit lookup, with a substring fallback when absent.

use rusqlite::{Connection, params};
use std::collections::HashSet;

use crate::error::{UcError, UcResult};

pub(crate) fn index_search(conn: &Connection, node_id: i64, body: &str) -> UcResult<()> {
    if body.trim().is_empty() {
        return Ok(());
    }
    // Let a failed FTS write surface; swallowing it silently corrupts search results.
    conn.execute(
        "INSERT INTO search_fts (node_id, body) VALUES (?1, ?2)",
        params![node_id, body],
    )
    .map(|_| ())
    .map_err(UcError::from)
}

pub(crate) fn fts_hit_rowids(conn: &Connection, query: &str) -> UcResult<Option<HashSet<i64>>> {
    if !fts_available(conn) {
        return Ok(None);
    }
    let mut stmt = match conn.prepare(
        "SELECT node_id FROM search_fts
         WHERE search_fts MATCH ?1
         LIMIT 2000",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Ok(None),
    };
    let phrase = fts_phrase(query);
    let rows = match stmt.query_map(params![phrase], |row| row.get::<_, i64>(0)) {
        Ok(rows) => rows,
        Err(_) => return Ok(None),
    };
    let mut out = HashSet::new();
    for row in rows {
        out.insert(row?);
    }
    Ok(Some(out))
}

// True when FTS flagged this rowid; None (no FTS) defers to the caller's substring check.
pub(crate) fn is_hit(fts_hits: &Option<HashSet<i64>>, rowid: i64) -> bool {
    match fts_hits {
        Some(hits) => hits.contains(&rowid),
        None => true,
    }
}

fn fts_available(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}
