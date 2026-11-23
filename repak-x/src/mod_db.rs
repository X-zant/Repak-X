//! Local mod database, `%APPDATA%/Repak-X/mods.db`.
//! The only module that touches SQLite; every write goes through [`db()`].

pub mod profiles;
pub mod reconcile;

use log::{error, warn};
use once_cell::sync::Lazy;
use parking_lot::{Mutex, MutexGuard};
use reconcile::{reconcile, Change, DiskEntry, Row};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const SCHEMA_VERSION: i32 = 4;
/// Scope shown in the log drawer
const LOG_SCOPE: &str = "Mod database";
/// Cached mod details kept; least recently used beyond this are evicted
const DETAILS_CACHE_CAP: i64 = 2000;

pub struct ModDb {
    conn: Connection,
    /// The mods folder (`game_path`); rows store paths relative to it
    root: Option<PathBuf>,
}

static DB: Lazy<Mutex<ModDb>> = Lazy::new(|| {
    // Tests must never touch the user's real database
    #[cfg(test)]
    return Mutex::new(ModDb::open_in_memory());
    #[cfg(not(test))]
    Mutex::new(ModDb::open_or_rebuild(&crate::app_dir().join("mods.db")))
});

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The single owner of the database. Hold the guard only for the call.
pub fn db() -> MutexGuard<'static, ModDb> {
    DB.lock()
}

/// What a mod file is matched on: its path relative to the mods folder, lowercase,
/// with `/` separators and the enabled/disabled extension dropped, so a toggle
/// keeps the key and a rename or move changes it.
pub fn path_key(rel: &Path) -> String {
    let s = rel.to_string_lossy().replace('\\', "/").to_lowercase();
    for ext in [".pak", ".bak_repak", ".pak_disabled"] {
        if let Some(base) = s.strip_suffix(ext) {
            return base.to_string();
        }
    }
    s
}

fn slash_path(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

/// `len:mtime` of a mod's `.pak` and its `.utoc`/`.ucas` siblings.
///
/// The `.pak` of an IoStore mod is a tiny stub whose mtime can survive a re-export
/// while the real content in the `.utoc`/`.ucas` changes, so the stamp covers all
/// three files. It leaves out the path on purpose: an enable/disable or rename keeps
/// size and mtime, so the details cache still hits.
pub fn stamp(path: &Path) -> String {
    let stat = |p: PathBuf| {
        std::fs::metadata(p)
            .ok()
            .and_then(|m| {
                let nanos = m
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()?
                    .as_nanos();
                Some(format!("{}:{}", m.len(), nanos))
            })
            .unwrap_or_else(|| "-".to_string())
    };
    [
        stat(path.to_path_buf()),
        stat(path.with_extension("utoc")),
        stat(path.with_extension("ucas")),
    ]
    .join("|")
}

/// Fingerprint of what a mod contains, used to find it again after a rename or
/// move done outside the app. A re-link heuristic, not an integrity check.
pub fn content_id(path: &Path) -> Option<String> {
    let utoc = path.with_extension("utoc");
    let mut lines: Vec<String> = if utoc.exists() {
        let files = crate::utoc_utils::try_read_utoc(&utoc).ok()?;
        // shortcut: the .utoc listing has no per-file sizes, so the .ucas size stands in;
        // a recompressed IoStore mod then re-mints instead of relinking. Upgrade if the
        // toolkit ever returns entry sizes.
        let ucas = std::fs::metadata(path.with_extension("ucas"))
            .map(|m| m.len())
            .unwrap_or(0);
        let mut lines: Vec<String> = files
            .into_iter()
            .map(|f| f.file_path.to_lowercase())
            .collect();
        lines.push(format!("\0ucas\0{}", ucas));
        lines
    } else {
        let listing =
            uasset_toolkit::list_pak(path.to_str()?, Some(crate::install_mod::AES_KEY_HEX), None)
                .ok()?;
        listing
            .files
            .into_iter()
            .map(|e| format!("{}\0{}", e.path.to_lowercase(), e.size))
            .collect()
    };
    if lines.is_empty() {
        return None;
    }
    lines.sort();
    Some(format!(
        "b3:{}",
        blake3::hash(lines.join("\n").as_bytes()).to_hex()
    ))
}

/// "3 new, 1 missing" for a scan, or None when nothing worth reporting changed.
/// Refreshes (a toggle, an in-place reinstall) are routine and left out.
fn change_summary(changes: &[Change]) -> Option<String> {
    let count = |f: fn(&Change) -> bool| changes.iter().filter(|c| f(c)).count();
    let parts: Vec<String> = [
        (count(|c| matches!(c, Change::New { .. })), "new"),
        (
            count(|c| matches!(c, Change::Relink { .. })),
            "found after a move",
        ),
        (
            count(|c| matches!(c, Change::Orphan { .. })),
            "missing (kept 7 days)",
        ),
        (
            count(|c| matches!(c, Change::Purge { .. })),
            "forgotten after 7 days missing",
        ),
    ]
    .into_iter()
    .filter(|(n, _)| *n > 0)
    .map(|(n, label)| format!("{} {}", n, label))
    .collect();
    (!parts.is_empty()).then(|| format!("Library: {}", parts.join(", ")))
}

static FILLING: AtomicBool = AtomicBool::new(false);

/// Computes missing content ids one mod at a time without holding the database
/// lock, so the scan never waits on reading every mod's file list.
fn fill_content_ids_in_background(root: PathBuf) {
    if cfg!(test) || FILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let todo = db().missing_content_ids().unwrap_or_default();
        let filled = fill_content_ids(&root, &todo);
        if !todo.is_empty() {
            crate::ui_log::debug(
                LOG_SCOPE,
                format!(
                    "Indexed {}/{} mod(s) for move detection",
                    filled,
                    todo.len()
                ),
            );
        }
        FILLING.store(false, Ordering::SeqCst);
    });
}

/// Reads and stores the content id of each `(uid, path, stamp)`, taking the
/// database lock only for each write. Returns how many were stored.
fn fill_content_ids(root: &Path, todo: &[(String, String, String)]) -> usize {
    let mut filled = 0;
    for (uid, path, stamp) in todo {
        let Some(cid) = content_id(&root.join(path)) else {
            continue;
        };
        // A stamp that moved on means the file changed meanwhile; the next scan redoes it
        let result = db().conn.execute(
            "UPDATE mods SET content_id = ?2 WHERE uid = ?1 AND stamp = ?3",
            params![uid, cid, stamp],
        );
        if result.is_ok() {
            filled += 1;
        }
    }
    filled
}

/// Installed mods that share a content id, as absolute paths, each group with
/// at least two. Reads the file list only of mods whose content id is not known
/// yet. Same content id means same file list, not same bytes: callers that act
/// on it confirm with something stricter.
pub fn same_content_groups(root: &Path) -> Vec<Vec<PathBuf>> {
    let todo = db().missing_content_ids().unwrap_or_default();
    fill_content_ids(root, &todo);

    let rows = db().live_content_ids().unwrap_or_else(|e| {
        error!("Reading content ids failed: {}", e);
        Vec::new()
    });
    let mut groups: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for (path, cid) in rows {
        groups.entry(cid).or_default().push(root.join(path));
    }
    groups.into_values().filter(|g| g.len() > 1).collect()
}

impl ModDb {
    fn with_conn(conn: Connection) -> Self {
        Self { conn, root: None }
    }

    fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Self::with_conn(Connection::open(path)?);
        db.migrate()?;
        Ok(db)
    }

    #[cfg(test)]
    fn open_in_memory() -> Self {
        let db = Self::with_conn(Connection::open_in_memory().unwrap());
        db.migrate().unwrap();
        db
    }

    /// Never hard-fails: a corrupt or newer-schema file is set aside as
    /// `mods.db.bad` and an empty database takes its place.
    fn open_or_rebuild(path: &Path) -> Self {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match Self::open(path) {
            Ok(db) => return db,
            Err(e) => crate::ui_log::error(
                LOG_SCOPE,
                format!(
                    "mods.db could not be opened ({}). Kept it as mods.db.bad and started an empty one: tags are lost",
                    e
                ),
            ),
        }
        let _ = std::fs::rename(path, path.with_extension("db.bad"));
        Self::open(path).unwrap_or_else(|e| {
            crate::ui_log::error(
                LOG_SCOPE,
                format!(
                    "Cannot create mods.db ({}). Tags and cached details are not saved this session",
                    e
                ),
            );
            let db = Self::with_conn(Connection::open_in_memory().expect("in-memory SQLite"));
            let _ = db.migrate();
            db
        })
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        let version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            // Written by a newer Repak X: don't clobber it (the caller backs it up)
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "schema v{} is newer than this build's v{}",
                version, SCHEMA_VERSION
            )));
        }
        if version < 1 {
            // Legacy tags keyed by get_mod_key(); since v3 only read, to seed new rows
            self.conn.execute_batch(
                "BEGIN;
                 CREATE TABLE mod_tags (mod_key TEXT NOT NULL, tag TEXT NOT NULL,
                                        PRIMARY KEY (mod_key, tag));
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        }
        if version < 2 {
            // Keyed on the files' size+mtime, not the path, so a toggle rename still hits
            self.conn.execute_batch(
                "BEGIN;
                 CREATE TABLE details_cache (stamp TEXT PRIMARY KEY,
                                             details_json TEXT NOT NULL,
                                             last_used INTEGER NOT NULL);
                 PRAGMA user_version = 2;
                 COMMIT;",
            )?;
        }
        if version < 3 {
            self.conn.execute_batch(
                "BEGIN;
                 CREATE TABLE mods (uid TEXT PRIMARY KEY, path_key TEXT NOT NULL,
                                    path TEXT NOT NULL, stamp TEXT NOT NULL,
                                    content_id TEXT, added_at INTEGER NOT NULL,
                                    orphaned_since INTEGER);
                 CREATE INDEX mods_by_key ON mods (path_key);
                 CREATE TABLE tags (uid TEXT NOT NULL, tag TEXT NOT NULL,
                                    PRIMARY KEY (uid, tag));
                 PRAGMA user_version = 3;
                 COMMIT;",
            )?;
        }
        if version < 4 {
            self.conn.execute_batch(profiles::SCHEMA_V4)?;
        }
        Ok(())
    }

    // ---- Details cache -------------------------------------------------

    /// Cached `ModDetails` JSON for a file stamp, or None on a miss or any error.
    pub fn cached_details(&self, stamp: &str) -> Option<String> {
        let json: Option<String> = self
            .conn
            .prepare_cached("SELECT details_json FROM details_cache WHERE stamp = ?1")
            .and_then(|mut stmt| stmt.query_row([stamp], |r| r.get(0)))
            .ok();
        if json.is_some() {
            // Day granularity: a hit only writes once a day, not on every read
            let now = unix_now();
            let _ = self.conn.execute(
                "UPDATE details_cache SET last_used = ?2 WHERE stamp = ?1 AND last_used < ?3",
                params![stamp, now, now - 86_400],
            );
        }
        json
    }

    pub fn store_details(&self, stamp: &str, json: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO details_cache VALUES (?1, ?2, ?3)",
            params![stamp, json, unix_now()],
        )?;
        self.conn.execute(
            "DELETE FROM details_cache WHERE stamp IN
               (SELECT stamp FROM details_cache ORDER BY last_used DESC LIMIT -1 OFFSET ?1)",
            [DETAILS_CACHE_CAP],
        )?;
        Ok(())
    }

    /// Drop every cached `ModDetails`. Their hero names come from the character
    /// database, so they go stale when it changes; the next view re-reads the PAK.
    pub fn clear_details(&self) -> rusqlite::Result<usize> {
        self.conn.execute("DELETE FROM details_cache", [])
    }

    /// One line for the startup banner: what the database holds.
    pub fn summary(&self) -> String {
        let count = |sql: &str| -> i64 { self.conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
        let mods = count("SELECT COUNT(*) FROM mods WHERE orphaned_since IS NULL");
        let tagged = count("SELECT COUNT(DISTINCT uid) FROM tags");
        let cached = count("SELECT COUNT(*) FROM details_cache");
        let bytes =
            count("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()");
        format!(
            "{} mod(s), {} tagged, {} with cached details, {:.1} MB",
            mods,
            tagged,
            cached,
            bytes as f64 / 1_048_576.0
        )
    }

    // ---- Identity and tags ---------------------------------------------

    /// Sets the mods folder that row paths are relative to.
    pub fn set_root(&mut self, root: &Path) {
        self.root = Some(root.to_path_buf());
    }

    fn rel<'a>(&self, abs: &'a Path) -> Option<&'a Path> {
        abs.strip_prefix(self.root.as_ref()?).ok()
    }

    fn live_uid(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .prepare_cached(
                "SELECT uid FROM mods WHERE path_key = ?1
                 ORDER BY orphaned_since IS NOT NULL LIMIT 1",
            )?
            .query_row([key], |r| r.get(0))
            .optional()
    }

    /// The uid of the mod at `abs`, adding a row if the scan has not seen it yet.
    fn ensure_uid(&self, abs: &Path) -> rusqlite::Result<String> {
        let rel = self
            .rel(abs)
            .ok_or_else(|| rusqlite::Error::InvalidPath(abs.to_path_buf()))?;
        let key = path_key(rel);
        if let Some(uid) = self.live_uid(&key)? {
            return Ok(uid);
        }
        let uid = uuid::Uuid::new_v4().to_string();
        // Empty stamp: the next scan refreshes it and the content id gets filled
        self.conn.execute(
            "INSERT INTO mods (uid, path_key, path, stamp, added_at) VALUES (?1, ?2, ?3, '', ?4)",
            params![uid, key, slash_path(rel), unix_now()],
        )?;
        Ok(uid)
    }

    /// Sorted tags of the mod at `abs`; empty on any error (tags are metadata, never fatal).
    pub fn tags_at(&self, abs: &Path) -> Vec<String> {
        let Some(rel) = self.rel(abs) else {
            return Vec::new();
        };
        let result = self
            .conn
            .prepare_cached(
                "SELECT t.tag FROM tags t JOIN mods m ON m.uid = t.uid
                 WHERE m.path_key = ?1 AND m.orphaned_since IS NULL ORDER BY t.tag",
            )
            .and_then(|mut stmt| stmt.query_map([path_key(rel)], |r| r.get(0))?.collect());
        result.unwrap_or_else(|e| {
            error!("Reading tags for {} failed: {}", abs.display(), e);
            Vec::new()
        })
    }

    pub fn add_tags_at(&self, abs: &Path, tags: &[String]) -> rusqlite::Result<()> {
        let uid = self.ensure_uid(abs)?;
        let mut stmt = self
            .conn
            .prepare_cached("INSERT OR IGNORE INTO tags VALUES (?1, ?2)")?;
        for tag in tags {
            stmt.execute(params![uid, tag])?;
        }
        Ok(())
    }

    pub fn remove_tag_at(&self, abs: &Path, tag: &str) -> rusqlite::Result<()> {
        let Some(rel) = self.rel(abs) else {
            return Ok(());
        };
        self.conn.execute(
            "DELETE FROM tags WHERE tag = ?2 AND uid IN
               (SELECT uid FROM mods WHERE path_key = ?1 AND orphaned_since IS NULL)",
            params![path_key(rel), tag],
        )?;
        Ok(())
    }

    /// The app renamed or replaced the mod at `old` with `new`: keep its uid.
    /// The empty stamp makes the next scan refresh it and recompute its content id.
    pub fn moved(&self, old: &Path, new: &Path) -> rusqlite::Result<()> {
        let (Some(old_rel), Some(new_rel)) = (self.rel(old), self.rel(new)) else {
            return Ok(());
        };
        let (old_key, new_key) = (path_key(old_rel), path_key(new_rel));
        if old_key != new_key {
            // A mod that was replaced at the destination keeps its row, as an orphan
            self.conn.execute(
                "UPDATE mods SET orphaned_since = ?2 WHERE path_key = ?1 AND orphaned_since IS NULL",
                params![new_key, unix_now()],
            )?;
        }
        self.conn.execute(
            "UPDATE mods SET path_key = ?2, path = ?3, stamp = '', orphaned_since = NULL
             WHERE path_key = ?1 AND orphaned_since IS NULL",
            params![old_key, new_key, slash_path(new_rel)],
        )?;
        Ok(())
    }

    /// The app renamed or moved a whole folder: re-point every mod inside it.
    pub fn moved_folder(&mut self, old_dir: &Path, new_dir: &Path) -> rusqlite::Result<()> {
        let (Some(old_rel), Some(new_rel)) = (self.rel(old_dir), self.rel(new_dir)) else {
            return Ok(());
        };
        let old_prefix = format!("{}/", path_key(old_rel));
        let depth = old_rel.components().count();
        let tx = self.conn.transaction()?;
        let rows: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare("SELECT uid, path_key, path FROM mods")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        for (uid, key, path) in rows {
            if !key.starts_with(&old_prefix) {
                continue;
            }
            let rest: PathBuf = Path::new(&path).components().skip(depth).collect();
            let new_path = new_rel.join(rest);
            tx.execute(
                "UPDATE mods SET path_key = ?2, path = ?3 WHERE uid = ?1",
                params![uid, path_key(&new_path), slash_path(&new_path)],
            )?;
        }
        tx.commit()
    }

    /// Adds legacy (`get_mod_key`) tags in one transaction; existing pairs are kept.
    /// New rows pick them up on the next scan.
    pub fn import_tags(&mut self, map: &HashMap<String, Vec<String>>) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached("INSERT OR IGNORE INTO mod_tags VALUES (?1, ?2)")?;
            for (key, tags) in map {
                for tag in tags {
                    stmt.execute(params![key, tag])?;
                }
            }
        }
        tx.commit()
    }

    fn missing_content_ids(&self) -> rusqlite::Result<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT uid, path, stamp FROM mods
             WHERE content_id IS NULL AND orphaned_since IS NULL AND stamp != ''",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect()
    }

    fn live_content_ids(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, content_id FROM mods
             WHERE content_id IS NOT NULL AND orphaned_since IS NULL",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    fn load_rows(&self) -> rusqlite::Result<Vec<Row>> {
        let mut stmt = self
            .conn
            .prepare("SELECT uid, path_key, path, stamp, content_id, orphaned_since FROM mods")?;
        let rows = stmt.query_map([], |r| {
            Ok(Row {
                uid: r.get(0)?,
                key: r.get(1)?,
                path: r.get(2)?,
                stamp: r.get(3)?,
                content_id: r.get(4)?,
                orphaned_since: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Reconciles the database with a full scan of the mods folder and returns
    /// each file's tags. The filesystem stays authoritative: rows are only ever
    /// refreshed, relinked, orphaned or (after 7 days orphaned) purged.
    pub fn sync_library(
        &mut self,
        root: &Path,
        files: &[PathBuf],
    ) -> HashMap<PathBuf, Vec<String>> {
        self.set_root(root);
        match self.sync_inner(root, files) {
            Ok(tags) => {
                fill_content_ids_in_background(root.to_path_buf());
                tags
            }
            Err(e) => {
                crate::ui_log::error(
                    LOG_SCOPE,
                    format!("Syncing with the mods folder failed, tags not shown: {}", e),
                );
                HashMap::new()
            }
        }
    }

    fn sync_inner(
        &mut self,
        root: &Path,
        files: &[PathBuf],
    ) -> rusqlite::Result<HashMap<PathBuf, Vec<String>>> {
        let mut entries = Vec::with_capacity(files.len());
        let mut abs_by_key: HashMap<String, &PathBuf> = HashMap::new();
        for file in files {
            let Ok(rel) = file.strip_prefix(root) else {
                continue;
            };
            let key = path_key(rel);
            abs_by_key.insert(key.clone(), file);
            entries.push(DiskEntry {
                key,
                path: slash_path(rel),
                stamp: stamp(file),
            });
        }

        let rows = self.load_rows()?;
        let now = unix_now();
        let changes = reconcile(&entries, &rows, now, &mut |e: &DiskEntry| {
            content_id(&root.join(&e.path))
        });

        let tx = self.conn.transaction()?;
        let mut legacy_used = Vec::new();
        for change in &changes {
            match change {
                Change::Refresh {
                    uid,
                    path,
                    stamp,
                    stale_content_id,
                } => {
                    tx.execute(
                        "UPDATE mods SET path = ?2, stamp = ?3, orphaned_since = NULL,
                           content_id = CASE WHEN ?4 THEN NULL ELSE content_id END
                         WHERE uid = ?1",
                        params![uid, path, stamp, stale_content_id],
                    )?;
                }
                Change::Relink {
                    uid,
                    key,
                    path,
                    stamp,
                } => {
                    crate::ui_log::info(
                        LOG_SCOPE,
                        format!("Recognised a mod moved outside Repak X: {}", path),
                    );
                    tx.execute(
                        "UPDATE mods SET path_key = ?2, path = ?3, stamp = ?4,
                           orphaned_since = NULL WHERE uid = ?1",
                        params![uid, key, path, stamp],
                    )?;
                }
                Change::New {
                    key,
                    path,
                    stamp,
                    content_id,
                } => {
                    let uid = uuid::Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO mods (uid, path_key, path, stamp, content_id, added_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![uid, key, path, stamp, content_id, now],
                    )?;
                    // Tags saved before mods had a uid (state.json, Phase 0 db)
                    let legacy = crate::get_mod_key(&root.join(path));
                    tx.execute(
                        "INSERT OR IGNORE INTO tags SELECT ?1, tag FROM mod_tags WHERE mod_key = ?2",
                        params![uid, legacy],
                    )?;
                    legacy_used.push(legacy);
                }
                Change::Orphan { uid } => {
                    tx.execute(
                        "UPDATE mods SET orphaned_since = ?2 WHERE uid = ?1",
                        params![uid, now],
                    )?;
                }
                Change::Purge { uid } => {
                    tx.execute("DELETE FROM tags WHERE uid = ?1", [uid])?;
                    tx.execute("DELETE FROM profile_members WHERE uid = ?1", [uid])?;
                    tx.execute("DELETE FROM mods WHERE uid = ?1", [uid])?;
                }
            }
        }
        // Deleted after the loop, so every file sharing a legacy key gets the tags
        for key in &legacy_used {
            tx.execute("DELETE FROM mod_tags WHERE mod_key = ?1", [key])?;
        }
        tx.commit()?;
        if let Some(summary) = change_summary(&changes) {
            crate::ui_log::info(LOG_SCOPE, summary);
        }

        let mut tags: HashMap<PathBuf, Vec<String>> = HashMap::new();
        let mut stmt = self.conn.prepare(
            "SELECT m.path_key, t.tag FROM tags t JOIN mods m ON m.uid = t.uid
             WHERE m.orphaned_since IS NULL ORDER BY t.tag",
        )?;
        let pairs = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?;
        for pair in pairs {
            let (key, tag) = pair?;
            match abs_by_key.get(&key) {
                Some(abs) => tags.entry((*abs).clone()).or_default().push(tag),
                None => warn!("Tag {} on a mod not in this scan: {}", tag, key),
            }
        }
        Ok(tags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_key_ignores_toggle_and_case() {
        assert_eq!(path_key(Path::new("Skins\\Venom_P.pak")), "skins/venom_p");
        assert_eq!(
            path_key(Path::new("Skins/Venom_P.bak_repak")),
            "skins/venom_p"
        );
        assert_eq!(path_key(Path::new("Venom_P.pak_disabled")), "venom_p");
    }

    #[test]
    fn change_summary_skips_routine_refreshes() {
        let refresh = Change::Refresh {
            uid: "u".into(),
            path: "a.pak".into(),
            stamp: "s".into(),
            stale_content_id: false,
        };
        assert_eq!(change_summary(&[refresh]), None);
        let changes = [
            Change::Orphan { uid: "a".into() },
            Change::Orphan { uid: "b".into() },
        ];
        assert_eq!(
            change_summary(&changes).as_deref(),
            Some("Library: 2 missing (kept 7 days)")
        );
        assert!(ModDb::open_in_memory()
            .summary()
            .starts_with("0 mod(s), 0 tagged"));
    }

    #[test]
    fn tags_follow_a_mod_through_migration_toggle_and_rename() {
        let root = Path::new("C:/mods");
        let mut db = ModDb::open_in_memory();
        // Phase 0 data keyed by get_mod_key
        db.import_tags(&HashMap::from([("Venom".into(), vec!["skin".into()])]))
            .unwrap();

        let on = root.join("Skins/Venom_9999999_P.pak");
        let tags = db.sync_library(root, &[on.clone()]);
        assert_eq!(tags[&on], ["skin"]);

        db.add_tags_at(&on, &["wip".into()]).unwrap();
        let off = root.join("Skins/Venom_9999999_P.bak_repak");
        assert_eq!(db.sync_library(root, &[off.clone()])[&off], ["skin", "wip"]);

        // Same name in another folder is a different mod now
        let other = root.join("WIP/Venom_9999999_P.pak");
        let tags = db.sync_library(root, &[off.clone(), other.clone()]);
        assert!(!tags.contains_key(&other));

        let renamed = root.join("Skins/Symbiote_9999999_P.bak_repak");
        db.moved(&off, &renamed).unwrap();
        db.remove_tag_at(&renamed, "skin").unwrap();
        assert_eq!(db.sync_library(root, &[renamed.clone()])[&renamed], ["wip"]);

        db.moved_folder(&root.join("Skins"), &root.join("Heroes/Skins"))
            .unwrap();
        let moved = root.join("Heroes/Skins/Symbiote_9999999_P.bak_repak");
        assert_eq!(db.tags_at(&moved), ["wip"]);
    }

    #[test]
    fn same_content_groups_pairs_live_rows_only() {
        // The only test using the global (in-memory under test) database
        db().conn
            .execute_batch(
                "INSERT INTO mods (uid, path_key, path, stamp, content_id, added_at, orphaned_since)
                 VALUES ('a', 'x', 'X.pak', 's', 'c1', 0, NULL),
                        ('b', 'y', 'Sub/Y.bak_repak', 's', 'c1', 0, NULL),
                        ('c', 'z', 'Z.pak', 's', 'c2', 0, NULL),
                        ('d', 'w', 'W.pak', 's', 'c1', 0, 5);",
            )
            .unwrap();
        let root = Path::new("C:/mods");
        let mut groups = same_content_groups(root);
        assert_eq!(groups.len(), 1);
        groups[0].sort();
        assert_eq!(
            groups[0],
            [root.join("Sub/Y.bak_repak"), root.join("X.pak")]
        );
    }

    #[test]
    fn details_cache_hits_and_evicts() {
        let db = ModDb::open_in_memory();
        assert!(db.cached_details("s1").is_none());
        db.store_details("s1", "{\"a\":1}").unwrap();
        assert_eq!(db.cached_details("s1").as_deref(), Some("{\"a\":1}"));

        // s1 is the oldest once the cap is exceeded
        db.conn
            .execute("UPDATE details_cache SET last_used = 0", [])
            .unwrap();
        for i in 0..DETAILS_CACHE_CAP {
            db.store_details(&format!("n{}", i), "{}").unwrap();
        }
        assert!(db.cached_details("s1").is_none());
        assert!(db.cached_details("n0").is_some());

        db.clear_details().unwrap();
        assert!(db.cached_details("n0").is_none());
    }

    #[test]
    fn corrupt_and_newer_files_are_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mods.db");

        std::fs::write(&path, b"not a database at all, just junk bytes here").unwrap();
        let db = ModDb::open_or_rebuild(&path);
        assert!(dir.path().join("mods.db.bad").exists());
        db.store_details("a", "{}").unwrap();
        drop(db);
        assert!(ModDb::open_or_rebuild(&path).cached_details("a").is_some());

        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        drop(conn);
        let db = ModDb::open_or_rebuild(&path);
        assert!(db.cached_details("a").is_none());
    }
}
