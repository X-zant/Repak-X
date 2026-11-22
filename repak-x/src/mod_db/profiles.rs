//! Mod list profiles (docs/MOD_DB_PLAN.md §6): a named, explicitly saved
//! snapshot of which mods are enabled. A profile owns nothing else.
//!
//! Both states are stored per mod, so a mod the profile has never seen is left
//! alone on a switch instead of being disabled.

use super::{unix_now, ModDb};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
    pub saved_at: i64,
}

/// A switch that stopped partway (game holding a file, crash, power loss).
#[derive(Serialize, Clone)]
pub struct PendingSwitch {
    pub profile_name: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Serialize, Clone)]
pub struct ProfileStatus {
    pub profiles: Vec<ProfileInfo>,
    pub active: Option<String>,
    /// The mods on disk no longer match the active profile
    pub dirty: bool,
    /// Installed mods the active profile has never seen; a switch leaves them alone
    pub unknown: usize,
    pub pending_switch: Option<PendingSwitch>,
}

/// One rename of a profile switch, from the journal.
pub struct SwitchOp {
    pub seq: i64,
    pub profile_id: String,
    pub from: PathBuf,
    pub to: PathBuf,
    pub done: bool,
}

pub(super) const SCHEMA_V4: &str = "BEGIN;
     CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                            created_at INTEGER NOT NULL, saved_at INTEGER NOT NULL);
     CREATE TABLE profile_members (profile_id TEXT NOT NULL, uid TEXT NOT NULL,
                                   enabled INTEGER NOT NULL, PRIMARY KEY (profile_id, uid));
     CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE pending_switch (seq INTEGER PRIMARY KEY, profile_id TEXT NOT NULL,
                                  from_path TEXT NOT NULL, to_path TEXT NOT NULL,
                                  done INTEGER NOT NULL DEFAULT 0);
     PRAGMA user_version = 4;
     COMMIT;";

fn is_enabled(file: &Path) -> bool {
    file.extension().and_then(|e| e.to_str()) == Some("pak")
}

/// The renames that make `current` match `members`. Mods the profile lists but
/// that are not installed, and installed mods it does not list, are skipped.
/// Only the `.pak` is renamed, like a single toggle: `.utoc`/`.ucas` keep the
/// base name in both states.
pub fn switch_ops(
    members: &[(String, bool)],
    current: &HashMap<String, PathBuf>,
) -> Vec<(PathBuf, PathBuf)> {
    members
        .iter()
        .filter_map(|(uid, want_enabled)| {
            let file = current.get(uid)?;
            if is_enabled(file) == *want_enabled {
                return None;
            }
            let ext = if *want_enabled { "pak" } else { "bak_repak" };
            Some((file.clone(), file.with_extension(ext)))
        })
        .collect()
}

impl ModDb {
    fn active_profile(&self) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'active_profile'",
                [],
                |r| r.get(0),
            )
            .optional()
    }

    fn set_active_profile(&self, id: Option<&str>) -> rusqlite::Result<()> {
        match id {
            Some(id) => self.conn.execute(
                "INSERT OR REPLACE INTO settings VALUES ('active_profile', ?1)",
                [id],
            )?,
            None => self
                .conn
                .execute("DELETE FROM settings WHERE key = 'active_profile'", [])?,
        };
        Ok(())
    }

    /// uid -> the mod's file as it is on disk now. Row paths can lag a toggle
    /// until the next scan, so every enabled/disabled name is checked.
    fn installed_files(&self) -> rusqlite::Result<HashMap<String, PathBuf>> {
        let Some(root) = self.root.clone() else {
            return Ok(HashMap::new());
        };
        let mut stmt = self
            .conn
            .prepare("SELECT uid, path FROM mods WHERE orphaned_since IS NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut files = HashMap::new();
        for row in rows {
            let (uid, path) = row?;
            let base = root.join(path);
            let found = std::iter::once(base.clone())
                .chain(["pak", "bak_repak", "pak_disabled"].map(|e| base.with_extension(e)))
                .find(|p| p.is_file());
            if let Some(file) = found {
                files.insert(uid, file);
            }
        }
        Ok(files)
    }

    fn members(&self, profile_id: &str) -> rusqlite::Result<Vec<(String, bool)>> {
        let mut stmt = self.conn.prepare(
            "SELECT uid, enabled FROM profile_members WHERE profile_id = ?1 ORDER BY uid",
        )?;
        let rows = stmt.query_map([profile_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    fn write_snapshot(&mut self, profile_id: &str) -> rusqlite::Result<()> {
        let files = self.installed_files()?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM profile_members WHERE profile_id = ?1",
            [profile_id],
        )?;
        {
            let mut stmt = tx.prepare("INSERT INTO profile_members VALUES (?1, ?2, ?3)")?;
            for (uid, file) in &files {
                stmt.execute(params![profile_id, uid, is_enabled(file)])?;
            }
        }
        tx.execute(
            "UPDATE profiles SET saved_at = ?2 WHERE id = ?1",
            params![profile_id, unix_now()],
        )?;
        tx.commit()
    }

    pub fn profile_status(&self) -> rusqlite::Result<ProfileStatus> {
        let profiles = {
            let mut stmt = self
                .conn
                .prepare("SELECT id, name, saved_at FROM profiles ORDER BY name COLLATE NOCASE")?;
            let rows = stmt.query_map([], |r| {
                Ok(ProfileInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    saved_at: r.get(2)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let active = self.active_profile()?;
        let (mut dirty, mut unknown) = (false, 0);
        if let Some(id) = &active {
            let members: HashMap<String, bool> = self.members(id)?.into_iter().collect();
            for (uid, file) in self.installed_files()? {
                match members.get(&uid) {
                    Some(&want) => dirty |= want != is_enabled(&file),
                    None => unknown += 1,
                }
            }
            // A newly installed mod is enabled and unsaved: the profile is out of date
            dirty |= unknown > 0;
        }

        let ops = self.pending_switch()?;
        let pending_switch = match ops.first() {
            Some(op) => Some(PendingSwitch {
                profile_name: profiles
                    .iter()
                    .find(|p| p.id == op.profile_id)
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|| "a deleted profile".to_string()),
                done: ops.iter().filter(|o| o.done).count(),
                total: ops.len(),
            }),
            None => None,
        };

        Ok(ProfileStatus {
            profiles,
            active,
            dirty,
            unknown,
            pending_switch,
        })
    }

    /// A new profile holding the current enabled/disabled state; it becomes active.
    pub fn create_profile(&mut self, name: &str) -> rusqlite::Result<String> {
        let id = format!("p_{}", uuid::Uuid::new_v4().simple());
        let now = unix_now();
        self.conn.execute(
            "INSERT INTO profiles VALUES (?1, ?2, ?3, ?3)",
            params![id, name, now],
        )?;
        self.write_snapshot(&id)?;
        self.set_active_profile(Some(&id))?;
        Ok(id)
    }

    /// Overwrites the profile with what is on disk now.
    pub fn save_profile(&mut self, id: &str) -> rusqlite::Result<()> {
        self.write_snapshot(id)?;
        self.set_active_profile(Some(id))
    }

    pub fn rename_profile(&self, id: &str, name: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE profiles SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        Ok(())
    }

    /// Installed mods profile `id` has never seen: their files, sorted by name.
    pub fn unknown_mods(&self, id: &str) -> rusqlite::Result<Vec<PathBuf>> {
        let known: std::collections::HashSet<String> =
            self.members(id)?.into_iter().map(|(uid, _)| uid).collect();
        let mut files: Vec<PathBuf> = self
            .installed_files()?
            .into_iter()
            .filter(|(uid, _)| !known.contains(uid))
            .map(|(_, file)| file)
            .collect();
        files.sort_by_key(|f| f.file_name().map(|n| n.to_ascii_lowercase()));
        Ok(files)
    }

    /// Adds the mods profile `id` has never seen to it, so a switch stops
    /// skipping them: `enabled` sets them all on or off, `None` keeps each as it is now.
    pub fn adopt_unknown_mods(&mut self, id: &str, enabled: Option<bool>) -> rusqlite::Result<()> {
        let known: std::collections::HashSet<String> =
            self.members(id)?.into_iter().map(|(uid, _)| uid).collect();
        let files = self.installed_files()?;
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare("INSERT INTO profile_members VALUES (?1, ?2, ?3)")?;
            for (uid, file) in files.iter().filter(|(uid, _)| !known.contains(*uid)) {
                stmt.execute(params![
                    id,
                    uid,
                    enabled.unwrap_or_else(|| is_enabled(file))
                ])?;
            }
        }
        tx.commit()
    }

    pub fn delete_profile(&mut self, id: &str) -> rusqlite::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM profile_members WHERE profile_id = ?1", [id])?;
        tx.execute("DELETE FROM profiles WHERE id = ?1", [id])?;
        tx.execute(
            "DELETE FROM settings WHERE key = 'active_profile' AND value = ?1",
            [id],
        )?;
        tx.commit()
    }

    /// Writes the journal for switching to `id` before anything on disk changes.
    /// Returns how many renames it holds; 0 means disk already matches.
    pub fn begin_switch(&mut self, id: &str) -> rusqlite::Result<usize> {
        let ops = switch_ops(&self.members(id)?, &self.installed_files()?);
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM pending_switch", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO pending_switch (profile_id, from_path, to_path) VALUES (?1, ?2, ?3)",
            )?;
            for (from, to) in &ops {
                stmt.execute(params![id, from.to_string_lossy(), to.to_string_lossy()])?;
            }
        }
        tx.commit()?;
        Ok(ops.len())
    }

    pub fn pending_switch(&self) -> rusqlite::Result<Vec<SwitchOp>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, profile_id, from_path, to_path, done FROM pending_switch ORDER BY seq",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SwitchOp {
                seq: r.get(0)?,
                profile_id: r.get(1)?,
                from: PathBuf::from(r.get::<_, String>(2)?),
                to: PathBuf::from(r.get::<_, String>(3)?),
                done: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn mark_switch_op(&self, seq: i64, done: bool) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE pending_switch SET done = ?2 WHERE seq = ?1",
            params![seq, done],
        )?;
        Ok(())
    }

    /// Clears the journal; `activate` is the profile that now matches disk, if any.
    pub fn finish_switch(&mut self, activate: Option<&str>) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM pending_switch", [])?;
        if let Some(id) = activate {
            self.set_active_profile(Some(id))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_ops_change_only_known_mismatched_mods() {
        let current = HashMap::from([
            ("on".to_string(), PathBuf::from("m/A.pak")),
            ("off".to_string(), PathBuf::from("m/B.bak_repak")),
            ("legacy_off".to_string(), PathBuf::from("m/C.pak_disabled")),
            ("unknown".to_string(), PathBuf::from("m/D.pak")),
        ]);
        let members = [
            ("on".to_string(), false),
            ("off".to_string(), false),
            ("legacy_off".to_string(), true),
            ("not_installed".to_string(), true),
        ];
        assert_eq!(
            switch_ops(&members, &current),
            [
                (PathBuf::from("m/A.pak"), PathBuf::from("m/A.bak_repak")),
                (PathBuf::from("m/C.pak_disabled"), PathBuf::from("m/C.pak")),
            ]
        );
    }

    #[test]
    fn profile_tracks_dirty_unknown_and_journal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let a = root.join("A.pak");
        let b = root.join("B.bak_repak");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        let mut db = ModDb::open_in_memory();
        db.sync_library(root, &[a.clone(), b.clone()]);
        let id = db.create_profile("PvP").unwrap();
        let status = db.profile_status().unwrap();
        assert_eq!(status.active.as_deref(), Some(id.as_str()));
        assert!(!status.dirty);

        // Toggle A off by hand: dirty, and a switch back re-enables only A
        let a_off = root.join("A.bak_repak");
        std::fs::rename(&a, &a_off).unwrap();
        assert!(db.profile_status().unwrap().dirty);

        // A new mod the profile never saw
        let c = root.join("C.pak");
        std::fs::write(&c, b"c").unwrap();
        db.sync_library(root, &[a_off.clone(), b.clone(), c.clone()]);
        assert_eq!(db.profile_status().unwrap().unknown, 1);
        assert_eq!(db.unknown_mods(&id).unwrap(), [c.clone()]);

        assert_eq!(db.begin_switch(&id).unwrap(), 1);
        let ops = db.pending_switch().unwrap();
        assert_eq!((ops[0].from.clone(), ops[0].to.clone()), (a_off, a));
        let pending = db.profile_status().unwrap().pending_switch.unwrap();
        assert_eq!((pending.done, pending.total), (0, 1));

        db.finish_switch(Some(&id)).unwrap();
        assert!(db.profile_status().unwrap().pending_switch.is_none());

        // Telling the profile to disable it adds one more rename to the switch
        db.adopt_unknown_mods(&id, Some(false)).unwrap();
        assert!(db.unknown_mods(&id).unwrap().is_empty());
        assert_eq!(db.begin_switch(&id).unwrap(), 2);
        db.finish_switch(None).unwrap();

        db.delete_profile(&id).unwrap();
        let status = db.profile_status().unwrap();
        assert!(status.profiles.is_empty() && status.active.is_none());
    }
}
