//! Matches the mod files on disk to rows in mods.db (docs/MOD_DB_PLAN.md §3).
//! Pure: no disk or database access, so it can be tested directly. The only I/O,
//! reading a file's content id, comes in through a callback.

use std::collections::{HashMap, HashSet};

/// Rows missing from disk this long are deleted with their tags
pub const ORPHAN_RETENTION_SECS: i64 = 7 * 24 * 3600;

/// One mod file found by the scan.
pub struct DiskEntry {
    /// `path_key()` of the file: survives enable/disable, not a rename or move
    pub key: String,
    /// Path relative to the mods root, as on disk
    pub path: String,
    /// Size and mtime of the files; changes when the content does
    pub stamp: String,
}

/// One row of the `mods` table.
pub struct Row {
    pub uid: String,
    pub key: String,
    pub path: String,
    pub stamp: String,
    pub content_id: Option<String>,
    pub orphaned_since: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub enum Change {
    /// Same key as before but something moved on; a new stamp means the content id is stale
    Refresh {
        uid: String,
        path: String,
        stamp: String,
        stale_content_id: bool,
    },
    /// Renamed or moved outside the app, found again by its content id
    Relink {
        uid: String,
        key: String,
        path: String,
        stamp: String,
    },
    /// A mod the database has never seen
    New {
        key: String,
        path: String,
        stamp: String,
        content_id: Option<String>,
    },
    Orphan {
        uid: String,
    },
    Purge {
        uid: String,
    },
}

/// `content_id` is only called for files that match no row by key, and only when
/// an unmatched row with a content id has the same stamp: a rename or move keeps
/// size and mtime, so a file with a stamp no such row has cannot be a relink.
pub fn reconcile(
    entries: &[DiskEntry],
    rows: &[Row],
    now: i64,
    content_id: &mut dyn FnMut(&DiskEntry) -> Option<String>,
) -> Vec<Change> {
    let mut changes = Vec::new();
    let mut claimed = vec![false; rows.len()];

    let mut by_key: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        by_key.entry(row.key.as_str()).or_default().push(i);
    }

    let mut unmatched = Vec::new();
    for entry in entries {
        // A live row beats an orphan left behind at the same path (e.g. a replaced mod)
        let hit = by_key.get(entry.key.as_str()).and_then(|ids| {
            let free = || ids.iter().copied().filter(|&i| !claimed[i]);
            free()
                .find(|&i| rows[i].orphaned_since.is_none())
                .or_else(|| free().next())
        });
        let Some(i) = hit else {
            unmatched.push(entry);
            continue;
        };
        claimed[i] = true;
        let row = &rows[i];
        let stale = row.stamp != entry.stamp;
        if stale || row.path != entry.path || row.orphaned_since.is_some() {
            changes.push(Change::Refresh {
                uid: row.uid.clone(),
                path: entry.path.clone(),
                stamp: entry.stamp.clone(),
                stale_content_id: stale,
            });
        }
    }

    let mut by_content: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut relink_stamps: HashSet<&str> = HashSet::new();
    for (i, row) in rows.iter().enumerate() {
        if let (false, Some(cid)) = (claimed[i], row.content_id.as_deref()) {
            by_content.entry(cid).or_default().push(i);
            relink_stamps.insert(row.stamp.as_str());
        }
    }

    for entry in unmatched {
        // Nothing it could relink to: the content id is filled in later, off the scan
        let cid = if relink_stamps.contains(entry.stamp.as_str()) {
            content_id(entry)
        } else {
            None
        };
        let hit = cid
            .as_deref()
            .and_then(|c| by_content.get(c))
            .and_then(|ids| ids.iter().copied().find(|&i| !claimed[i]));
        match hit {
            Some(i) => {
                claimed[i] = true;
                changes.push(Change::Relink {
                    uid: rows[i].uid.clone(),
                    key: entry.key.clone(),
                    path: entry.path.clone(),
                    stamp: entry.stamp.clone(),
                });
            }
            None => changes.push(Change::New {
                key: entry.key.clone(),
                path: entry.path.clone(),
                stamp: entry.stamp.clone(),
                content_id: cid,
            }),
        }
    }

    for (i, row) in rows.iter().enumerate() {
        if claimed[i] {
            continue;
        }
        match row.orphaned_since {
            None => changes.push(Change::Orphan {
                uid: row.uid.clone(),
            }),
            Some(since) if now - since > ORPHAN_RETENTION_SECS => changes.push(Change::Purge {
                uid: row.uid.clone(),
            }),
            Some(_) => {}
        }
    }

    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, stamp: &str) -> DiskEntry {
        DiskEntry {
            key: key.into(),
            path: format!("{}.pak", key),
            stamp: stamp.into(),
        }
    }

    fn row(uid: &str, key: &str, stamp: &str, cid: Option<&str>) -> Row {
        Row {
            uid: uid.into(),
            key: key.into(),
            path: format!("{}.pak", key),
            stamp: stamp.into(),
            content_id: cid.map(Into::into),
            orphaned_since: None,
        }
    }

    fn cids(map: &[(&str, &str)]) -> impl FnMut(&DiskEntry) -> Option<String> {
        let map: HashMap<String, String> = map
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |e| map.get(&e.key).cloned()
    }

    #[test]
    fn unchanged_library_writes_nothing() {
        let rows = [row("u1", "a", "s", Some("c1"))];
        let mut never = |_: &DiskEntry| panic!("content id read for a matched file");
        assert!(reconcile(&[entry("a", "s")], &rows, 0, &mut never).is_empty());
    }

    #[test]
    fn rename_outside_the_app_relinks_by_content() {
        let rows = [row("u1", "old", "s", Some("c1"))];
        let changes = reconcile(&[entry("new", "s")], &rows, 0, &mut cids(&[("new", "c1")]));
        assert_eq!(
            changes,
            [Change::Relink {
                uid: "u1".into(),
                key: "new".into(),
                path: "new.pak".into(),
                stamp: "s".into()
            }]
        );
    }

    #[test]
    fn new_file_with_a_fresh_stamp_skips_the_content_read() {
        // An orphan with a content id exists, but no file shares its stamp
        let mut gone = row("u1", "gone", "s1", Some("c1"));
        gone.orphaned_since = Some(0);
        let mut never = |_: &DiskEntry| panic!("content id read for a file that cannot relink");
        let changes = reconcile(&[entry("fresh", "s2")], &[gone], 0, &mut never);
        assert!(matches!(changes.as_slice(), [Change::New { content_id: None, .. }]));
    }

    #[test]
    fn new_file_vanished_file_and_expired_orphan() {
        let mut gone = row("u2", "gone", "s", None);
        gone.orphaned_since = Some(0);
        let rows = [row("u1", "missing", "s", None), gone];
        let mut none = |_: &DiskEntry| None;
        let changes = reconcile(
            &[entry("fresh", "s")],
            &rows,
            ORPHAN_RETENTION_SECS + 1,
            &mut none,
        );
        assert_eq!(
            changes,
            [
                Change::New {
                    key: "fresh".into(),
                    path: "fresh.pak".into(),
                    stamp: "s".into(),
                    content_id: None
                },
                Change::Orphan { uid: "u1".into() },
                Change::Purge { uid: "u2".into() },
            ]
        );
    }

    #[test]
    fn reinstall_in_place_and_orphan_return() {
        let mut back = row("u2", "back", "s", Some("c2"));
        back.orphaned_since = Some(10);
        let rows = [row("u1", "a", "old", Some("c1")), back];
        let mut none = |_: &DiskEntry| None;
        let changes = reconcile(
            &[entry("a", "new"), entry("back", "s")],
            &rows,
            20,
            &mut none,
        );
        assert_eq!(
            changes,
            [
                Change::Refresh {
                    uid: "u1".into(),
                    path: "a.pak".into(),
                    stamp: "new".into(),
                    stale_content_id: true
                },
                Change::Refresh {
                    uid: "u2".into(),
                    path: "back.pak".into(),
                    stamp: "s".into(),
                    stale_content_id: false
                },
            ]
        );
    }

    #[test]
    fn duplicate_copy_gets_its_own_row() {
        // `a` keeps its row; the copy with identical content becomes a new mod
        let rows = [row("u1", "a", "s", Some("c1"))];
        let changes = reconcile(
            &[entry("a", "s"), entry("copy", "s")],
            &rows,
            0,
            &mut cids(&[("copy", "c1")]),
        );
        assert!(matches!(changes.as_slice(), [Change::New { key, .. }] if key == "copy"));
    }
}
