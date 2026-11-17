//! Recently deleted: a deleted mod's files move to `%APPDATA%/Repak-X/trash/<id>/`
//! instead of being removed, so the delete can be undone. Each deletion is one
//! folder holding the files and a `meta.json` naming where each came from.
//! Entries older than the retention setting are purged at start.
//!
//! The trash lives in app data, not beside `~mods`: the game mounts paks in every
//! folder under Content/Paks, so a trash folder there would still load.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
pub struct TrashFile {
    /// Where the file was when it was deleted
    pub original: PathBuf,
    /// Its name inside the entry folder
    pub stored: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    /// The mod's file name without extension, for the list
    pub name: String,
    /// Unix seconds
    pub deleted_at: u64,
    pub size: u64,
    pub files: Vec<TrashFile>,
}

pub fn trash_root() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("Repak-X")
        .join("trash")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rename, or copy then delete when the trash is on another drive than the mods.
fn move_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst)?;
    if let Err(e) = std::fs::remove_file(src) {
        // Leave no second copy behind when the original cannot go (file in use)
        let _ = std::fs::remove_file(dst);
        return Err(e);
    }
    Ok(())
}

/// One deletion in progress. Files go in with `discard`; `finish` writes the
/// entry's meta.json, or removes the empty folder when nothing went in.
pub struct TrashBatch {
    entry: TrashEntry,
    dir: PathBuf,
}

impl TrashBatch {
    pub fn begin(name: &str) -> std::io::Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = trash_root().join(&id);
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            entry: TrashEntry {
                id,
                name: name.to_string(),
                deleted_at: now_secs(),
                size: 0,
                files: Vec::new(),
            },
            dir,
        })
    }

    /// Move one of the mod's files into this entry.
    pub fn discard(&mut self, path: &Path) -> std::io::Result<()> {
        let stored = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("file{}", self.entry.files.len()));
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        move_file(path, &self.dir.join(&stored))?;
        self.entry.size += size;
        self.entry.files.push(TrashFile { original: path.to_path_buf(), stored });
        Ok(())
    }

    /// The entry id, or None when no file went in.
    pub fn finish(self) -> Option<String> {
        if self.entry.files.is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
            return None;
        }
        let meta = serde_json::to_vec_pretty(&self.entry).ok()?;
        std::fs::write(self.dir.join("meta.json"), meta).ok()?;
        Some(self.entry.id)
    }
}

fn read_entry(dir: &Path) -> Option<TrashEntry> {
    let bytes = std::fs::read(dir.join("meta.json")).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Every entry, newest first.
pub fn list() -> Vec<TrashEntry> {
    let Ok(dirs) = std::fs::read_dir(trash_root()) else { return Vec::new() };
    let mut entries: Vec<TrashEntry> = dirs
        .flatten()
        .filter_map(|d| read_entry(&d.path()))
        .collect();
    entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    entries
}

/// The entry's folder, refusing ids that are not a plain folder name.
fn entry_dir(id: &str) -> Result<PathBuf, String> {
    let ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err(format!("Not a trash id: {id}"));
    }
    Ok(trash_root().join(id))
}

/// Put an entry's files back where they were. Refuses, changing nothing, when a
/// file of the same name is there again.
pub fn restore(id: &str) -> Result<Vec<PathBuf>, String> {
    let dir = entry_dir(id)?;
    let entry = read_entry(&dir).ok_or("That deleted mod is no longer in Recently deleted")?;
    if let Some(taken) = entry.files.iter().find(|f| f.original.exists()) {
        return Err(format!(
            "{} is installed again. Delete or rename it first, then restore.",
            taken.original.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    let mut restored: Vec<PathBuf> = Vec::new();
    for f in &entry.files {
        if let Some(parent) = f.original.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if let Err(e) = move_file(&dir.join(&f.stored), &f.original) {
            // Undo the part that went back, so the mod is never half restored
            for done in &restored {
                let _ = move_file(done, &dir.join(done.file_name().unwrap_or_default()));
            }
            return Err(format!("Could not restore {}: {e}", f.stored));
        }
        restored.push(f.original.clone());
    }
    let _ = std::fs::remove_dir_all(&dir);
    Ok(restored)
}

pub fn purge(id: &str) -> Result<(), String> {
    std::fs::remove_dir_all(entry_dir(id)?).map_err(|e| e.to_string())
}

pub fn purge_all() {
    let _ = std::fs::remove_dir_all(trash_root());
}

/// Delete entries older than `days`. Folders without a readable meta.json are
/// leftovers of a deletion cut short, and go too.
pub fn purge_expired(days: u32) {
    let cutoff = now_secs().saturating_sub(u64::from(days) * 86_400);
    let Ok(dirs) = std::fs::read_dir(trash_root()) else { return };
    for d in dirs.flatten() {
        let expired = read_entry(&d.path()).map_or(true, |e| e.deleted_at < cutoff);
        if expired {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ids_that_leave_the_trash() {
        for bad in ["", "..", "../x", "a/b", "a\\b", "C:"] {
            assert!(entry_dir(bad).is_err(), "{bad}");
        }
        assert!(entry_dir("3f2a-9c").is_ok());
    }
}
