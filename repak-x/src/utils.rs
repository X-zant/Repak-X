use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::{fs, io};

use log::{info, trace};
use regex_lite::Regex;

// Use the runtime character_data module instead of compile-time embedded data
use crate::character_data;

static SKIN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    // Matches patterns like 1033/1033503 or 1033\1033503 (forward or backslash)
    Regex::new(r"[0-9]{4}[/\\][0-9]{7}").unwrap()
});

// Regex to extract just the character ID (4 digits) from paths like /Characters/1021/ or /Hero_ST/1048/
// Also matches directory mod paths like Marvel/Characters/1065/... (without leading slash)
static CHAR_ID_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:Characters|Hero_ST|Hero)[/\\](\d{4})").unwrap());

// Regex to extract character ID from filenames (e.g., bnk_vo_1044001.bnk -> 1044)
// More strict pattern: requires the 7-digit skin ID to start with valid character ID range (10xx)
// This avoids false positives from random 7-digit numbers in filenames
static FILENAME_CHAR_ID_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    // Matches patterns like _1044001, vo_1044001, where 1044 is a character ID in 10xx range
    Regex::new(r"[_/](10[1-6]\d)(\d{3})").unwrap()
});

/// Result of mod characteristics detection, includes mod type and detected heroes
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModCharacteristics {
    pub mod_type: String,
    pub heroes: Vec<String>,
    /// Character name for display (e.g., "Blade" or "Hawkeye - Default")
    /// Empty if no specific character or multiple characters
    pub character_name: String,
    /// Pure mod category (e.g., "Audio", "Mesh", "VFX")
    /// Without character name prefix
    pub category: String,
    /// Additional categories that can appear alongside the main category
    /// e.g., Blueprint, Text - these are additive and don't override the main category
    pub additional_categories: Vec<String>,
    /// 4-digit character ID (e.g., "1011" for Hulk)
    /// Empty if no character or multiple characters detected
    pub character_id: String,
}

impl ModCharacteristics {
    /// Format the mod type with hero info for display
    #[allow(dead_code)]
    pub fn display_type(&self) -> String {
        if self.heroes.is_empty() {
            self.mod_type.clone()
        } else if self.heroes.len() == 1 {
            format!("{} ({})", self.heroes[0], self.mod_type)
        } else {
            format!(
                "Multiple Heroes ({}) ({})",
                self.heroes.len(),
                self.mod_type
            )
        }
    }
}

pub fn collect_files(paths: &mut Vec<PathBuf>, dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(paths, &path)?;
        } else {
            paths.push(entry.path());
        }
    }
    Ok(())
}

pub enum ModType {
    Default(String),
    Custom(String),
}

/// Get character/skin info from file path using runtime character data cache
/// This uses the updated data from roaming folder, not the compile-time embedded data
pub fn get_character_mod_skin(file: &str) -> Option<ModType> {
    let skin_id_match = SKIN_REGEX.captures(file);
    if let Some(caps) = skin_id_match {
        let full_match = caps[0].to_string();
        // Called once per asset path inside the scan loop, so everything in this
        // function is trace!: at info! a single mod produced one line per file,
        // and the logger's global lock made that the scan's bottleneck.
        trace!("SKIN_REGEX matched: {} in file: {}", full_match, file);
        // Extract just the 7-digit skin ID (skip the "1234/" or "1234\" prefix)
        // The match is like "1033/1033503" or "1033\1033503", we want the last 7 digits
        let skin_id = &full_match[full_match.len() - 7..];

        // Use the runtime character data lookup
        if let Some(skin) = character_data::get_character_by_skin_id(skin_id) {
            trace!("Found skin in database: {} - {}", skin.name, skin.skin_name);
            if skin.skin_name == "Default" {
                return Some(ModType::Default(format!(
                    "{} - {}",
                    &skin.name, &skin.skin_name
                )));
            }
            return Some(ModType::Custom(format!(
                "{} - {}",
                &skin.name, &skin.skin_name
            )));
        } else {
            trace!("Skin ID {} not found in database", skin_id);
        }
        None
    } else {
        // No match is the norm for nearly every file in a pak, so this was by far
        // the highest-volume line in the app. Guarded so the truncation work is
        // skipped entirely when trace is off, and cut on a char boundary:
        // `&file[..100]` panics when byte 100 lands mid-character.
        if log::log_enabled!(log::Level::Trace) {
            let cut = file
                .char_indices()
                .nth(100)
                .map(|(i, _)| i)
                .unwrap_or(file.len());
            trace!("SKIN_REGEX did not match file: {}", &file[..cut]);
        }
        None
    }
}
/// Get detailed mod characteristics including mod type and all detected heroes
pub fn get_pak_characteristics_detailed(mod_contents: Vec<String>) -> ModCharacteristics {
    let mut _fallback: Option<String> = None;

    // Track what content types we find
    let mut has_skeletal_mesh = false;
    let mut has_static_mesh = false;
    let mut has_texture = false;
    let mut has_material = false;
    let mut has_audio = false;
    let mut has_movies = false;
    let mut has_ui = false;
    let mut has_blueprint = false;
    let mut has_text = false;
    let mut character_name: Option<String> = None; // Full skin-specific name (e.g., "Hawkeye - Default")
    let mut hero_names: HashSet<String> = HashSet::new(); // All detected hero names
    let mut detected_char_id: Option<String> = None; // Track the 4-digit character ID
    let mut has_wbp_galacta = false; // Forces the 4017 (Galacta) icon regardless of other detection

    for file in &mod_contents {
        let path = file
            .strip_prefix("Marvel/Content/Marvel/")
            .or_else(|| file.strip_prefix("/Game/Marvel/"))
            .unwrap_or(file);

        let filename = path.split('/').last().unwrap_or("");
        let filename_lower = filename.to_lowercase();
        let path_lower = path.to_lowercase();

        // WBP_Galacta has no numeric hero ID in its path/filename for the
        // regexes below to pick up, so it's special-cased directly by name.
        if filename_lower.contains("wbp_galacta") {
            has_wbp_galacta = true;
        }

        // Check for specific asset types by filename pattern
        // Note: Internal paths may or may not have .uasset extension
        let is_uasset = filename_lower.ends_with(".uasset") || !filename_lower.contains('.');

        if filename_lower.starts_with("sk_") && is_uasset {
            has_skeletal_mesh = true;
        }
        if filename_lower.starts_with("sm_") && is_uasset {
            has_static_mesh = true;
        }
        if filename_lower.starts_with("t_") && is_uasset {
            has_texture = true;
        }

        // VFX: MI_ files in VFX path (e.g. /Game/Marvel/VFX/Materials/...)
        // Check both original file path and stripped path
        let file_lower = file.to_lowercase();
        if filename_lower.starts_with("mi_")
            && (path_lower.contains("/vfx/")
                || path_lower.starts_with("vfx/")
                || file_lower.contains("/vfx/"))
        {
            has_material = true;
        }

        // Check path-based categories
        if path_lower.contains("wwiseaudio") || file_lower.contains("wwiseaudio") {
            has_audio = true;
        }

        // UI: Files in UI folder
        if path_lower.contains("/ui/")
            || path_lower.starts_with("ui/")
            || file_lower.contains("/ui/")
        {
            has_ui = true;
        }

        // Movies: Files in Movies folder (placeholder - user to research exact criteria)
        if path_lower.contains("/movies/")
            || path_lower.starts_with("movies/")
            || file_lower.contains("/movies/")
            || path_lower.ends_with(".bik")
            || path_lower.ends_with(".mp4")
        {
            has_movies = true;
        }

        // Text: StringTable files (localization/text mods)
        if path_lower.contains("/stringtable/")
            || path_lower.starts_with("stringtable/")
            || file_lower.contains("/stringtable/")
            || path_lower.contains("/data/stringtable/")
        {
            has_text = true;
        }

        // Blueprint: Common Blueprint patterns
        // 1. BP_Something (Blueprint prefix)
        // 2. Something_C (Blueprint class suffix)
        // 3. SomethingBP (Blueprint suffix)
        // 4. /Blueprints/ folder path
        if (filename_lower.starts_with("bp_")
            || filename_lower.contains("_c.")
            || filename_lower.contains("bp.")
            || filename_lower.ends_with("bp")
            || path_lower.contains("/blueprints/"))
            && is_uasset
        {
            has_blueprint = true;
        }

        // Try to get skin-specific name from any path containing the skin pattern
        match get_character_mod_skin(path) {
            Some(ModType::Custom(skin)) => {
                trace!("Found custom skin: {} from path: {}", skin, path);
                character_name = Some(skin);
            }
            Some(ModType::Default(name)) => {
                trace!("Found default skin: {} from path: {}", name, path);
                _fallback = Some(name);
            }
            None => {
                // No skin-specific match, will use character ID detection below
            }
        }

        // Extract hero names ONLY from primary character folder paths
        // This handles paths like /Characters/1032/, /Hero_ST/1048/, /Hero/1021/
        // We ONLY look at folder structure, NOT filenames, to avoid false positives from shared assets
        let path_matched = CHAR_ID_REGEX
            .captures(file)
            .and_then(|caps| {
                caps.get(1).and_then(|char_id| {
                    let id = char_id.as_str();
                    character_data::get_character_name_from_id(id).map(|name| {
                        trace!(
                            "CHAR_ID_REGEX matched ID {} ({}) in path: {}",
                            id, name, file
                        );
                        hero_names.insert(name);
                        // Store the character ID if this is the first one detected
                        if detected_char_id.is_none() {
                            detected_char_id = Some(id.to_string());
                        }
                        true
                    })
                })
            })
            .unwrap_or(false);

        // Fallback: For audio/UI/texture mods WITHOUT character folders, check filenames
        // ONLY use this when path regex didn't match - prevents false positives from shared texture assets
        // (e.g., T_1018301 texture in a 1048 folder shouldn't count as hero 1018)
        if !path_matched && !filename_lower.starts_with("mi_") {
            if let Some(caps) = FILENAME_CHAR_ID_REGEX.captures(filename) {
                if let Some(char_id) = caps.get(1) {
                    let id = char_id.as_str();
                    if let Some(name) = character_data::get_character_name_from_id(id) {
                        trace!(
                            "FILENAME_CHAR_ID_REGEX matched ID {} ({}) in filename: {}",
                            id, name, filename
                        );
                        hero_names.insert(name);
                        // Store the character ID if this is the first one detected
                        if detected_char_id.is_none() {
                            detected_char_id = Some(id.to_string());
                        }
                    }
                }
            }
        }
    }

    // Force the Galacta (4017) hero icon whenever a WBP_Galacta asset is present,
    // overriding any other hero detected from the same mod.
    if has_wbp_galacta {
        hero_names.clear();
        hero_names.insert("Galacta".to_string());
        detected_char_id = Some("4017".to_string());
    }

    // Convert to sorted Vec for consistent ordering
    let mut heroes: Vec<String> = hero_names.into_iter().collect();
    heroes.sort();

    // One line per mod, replacing what used to be one line per asset path. This
    // is the part that is actually useful when a mod is mis-detected.
    info!(
        "Scanned {} path(s): heroes={:?} char_id={:?} skin={:?}",
        mod_contents.len(),
        heroes,
        detected_char_id,
        character_name
    );

    // Determine the pure category (without character name)
    // Priority order: Audio/Movies/UI (pure) > Mesh > Static Mesh > VFX > Audio (mixed) > Texture
    // Note: Blueprint and Text are now additive categories and handled separately
    let category = if has_audio
        && !has_skeletal_mesh
        && !has_static_mesh
        && !has_texture
        && !has_material
    {
        "Audio"
    } else if has_movies && !has_skeletal_mesh && !has_static_mesh && !has_texture && !has_material
    {
        "Movies"
    } else if has_ui && !has_skeletal_mesh && !has_static_mesh && !has_texture && !has_material {
        "UI"
    } else if has_skeletal_mesh {
        "Mesh"
    } else if has_static_mesh {
        "Static Mesh"
    } else if has_material {
        "VFX"
    } else if has_audio {
        "Audio"
    } else if has_texture {
        "Texture"
    } else if has_blueprint {
        // Blueprint-only mod (no other primary category detected)
        "Blueprint"
    } else if has_text {
        // Text-only mod (no other primary category detected)
        "Text"
    } else {
        "Unknown"
    };

    // Determine character_name for display
    // Priority: multiple heroes > skin-specific name > single hero > empty
    let display_character_name = if heroes.len() > 1 {
        // Multiple heroes detected - leave empty so "Multiple Heroes" is shown
        String::new()
    } else if let Some(ref char_name) = character_name {
        // Single hero with skin-specific name
        char_name.clone()
    } else if heroes.len() == 1 {
        // Single hero without skin info
        heroes[0].clone()
    } else {
        String::new()
    };

    // Build additional categories list (Additive types)
    let mut additional_categories = Vec::new();
    if has_skeletal_mesh && category != "Mesh" {
        additional_categories.push("Mesh".to_string());
    }
    if has_static_mesh && category != "Static Mesh" {
        additional_categories.push("Static Mesh".to_string());
    }
    if has_texture && category != "Texture" {
        additional_categories.push("Texture".to_string());
    }
    if has_material && category != "VFX" {
        additional_categories.push("VFX".to_string());
    }
    if has_audio && category != "Audio" {
        additional_categories.push("Audio".to_string());
    }
    if has_ui && category != "UI" {
        additional_categories.push("UI".to_string());
    }
    if has_blueprint && category != "Blueprint" {
        additional_categories.push("Blueprint".to_string());
    }
    if has_text && category != "Text" {
        additional_categories.push("Text".to_string());
    }

    // Build the combined mod_type string with " - " separator for easy splitting
    // Include additional categories in the display string
    let base_type = if !display_character_name.is_empty() {
        // Character detected - combine with " - " separator
        format!("{} - {}", display_character_name, category)
    } else if heroes.len() > 1 {
        // Multiple heroes
        format!("Multiple Heroes ({}) - {}", heroes.len(), category)
    } else {
        // No heroes detected - just category
        category.to_string()
    };

    // Append additional categories to the mod_type string
    let mod_type = if !additional_categories.is_empty() {
        format!("{} [{}]", base_type, additional_categories.join(", "))
    } else {
        base_type
    };

    // Determine final character_id: only set if exactly one hero detected
    let final_character_id = if heroes.len() == 1 {
        detected_char_id.unwrap_or_default()
    } else {
        String::new()
    };

    ModCharacteristics {
        mod_type,
        heroes,
        character_name: display_character_name,
        category: category.to_string(),
        additional_categories,
        character_id: final_character_id,
    }
}

/// Get mod characteristics as a display string (backward compatible)
/// Returns the mod_type string which uses " - " separator between character and category
/// Format: "Character - Category" or just "Category" if no character
pub fn get_current_pak_characteristics(mod_contents: Vec<String>) -> String {
    let chars = get_pak_characteristics_detailed(mod_contents);
    chars.mod_type
}

/// Finds every installed copy of the game's Paks folder, each with its launcher
/// ("steam" / "epic" / "loadingbay").
pub fn find_marvel_rivals() -> Vec<(PathBuf, &'static str)> {
    let mut found: Vec<(PathBuf, &'static str)> = Vec::new();

    for lib in get_steam_library_paths() {
        let path = lib.join("steamapps/common/MarvelRivals/MarvelGame/Marvel/Content/Paks");
        // Steam can list the same library twice (e.g. via symlinked roots)
        if path.exists() && !found.iter().any(|(p, _)| p == &path) {
            found.push((path, "steam"));
        }
    }

    // Epic: each installed game has a JSON .item manifest with its InstallLocation
    #[cfg(target_os = "windows")]
    if let Ok(entries) =
        std::fs::read_dir(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests")
    {
        for entry in entries.flatten() {
            let Ok(text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            if let Some(loc) = json["InstallLocation"].as_str() {
                let path = PathBuf::from(loc).join("MarvelGame/Marvel/Content/Paks");
                if path.exists() {
                    found.push((path, "epic"));
                }
            }
        }
    }

    // shortcut: assumes Loading Bay's default "<drive>:\Loading Bay Games" library; read its config if users pick custom folders
    #[cfg(target_os = "windows")]
    for drive in b'C'..=b'Z' {
        let path = PathBuf::from(format!(
            "{}:/Loading Bay Games/Marvel Rivals/MarvelGame/Marvel/Content/Paks",
            drive as char
        ));
        if path.exists() {
            found.push((path, "loadingbay"));
        }
    }

    found
}

/// Which of several installs the user most likely plays, with the reason, or None
/// when the evidence doesn't single one out (better no hint than a wrong one).
pub fn recommend_install(installs: &[PathBuf]) -> Option<(usize, &'static str)> {
    let signals: Vec<(bool, Option<std::time::SystemTime>)> = installs
        .iter()
        .map(|paks| {
            let entries: Vec<_> = fs::read_dir(paks)
                .map(|rd| rd.flatten().collect())
                .unwrap_or_default();
            // shortcut: assumes the game ships no subfolders in Paks, so any non-empty subfolder is a mods folder
            let has_mods = entries.iter().any(|e| {
                e.path().is_dir()
                    && fs::read_dir(e.path()).is_ok_and(|mut rd| rd.next().is_some())
            });
            let newest_pak = entries
                .iter()
                .filter(|e| e.path().extension().is_some_and(|x| x == "pak"))
                .filter_map(|e| e.metadata().and_then(|m| m.modified()).ok())
                .max();
            (has_mods, newest_pak)
        })
        .collect();
    pick_recommended(&signals)
}

/// 1. the only install with mods; 2. among the tied, the only one whose game paks are
/// over a day newer than the rest (it got the latest patch, the others went stale).
fn pick_recommended(signals: &[(bool, Option<std::time::SystemTime>)]) -> Option<(usize, &'static str)> {
    let with_mods: Vec<usize> = (0..signals.len()).filter(|&i| signals[i].0).collect();
    if with_mods.len() == 1 {
        return Some((with_mods[0], "has your mods"));
    }
    let pool: Vec<usize> = if with_mods.is_empty() { (0..signals.len()).collect() } else { with_mods };
    let best = *pool.iter().max_by_key(|&&i| signals[i].1)?;
    let best_time = signals[best].1?;
    let day = std::time::Duration::from_secs(86_400);
    let clear_winner = pool.iter().filter(|&&i| i != best).all(|&i| match signals[i].1 {
        Some(t) => best_time.duration_since(t).is_ok_and(|d| d > day),
        None => true,
    });
    clear_winner.then_some((best, "most recently updated"))
}

#[cfg(test)]
mod recommend_tests {
    use super::pick_recommended;
    use std::time::{Duration, SystemTime};

    #[test]
    fn picks_by_mods_then_clear_update_gap() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(3 * 86_400);
        let recent = now - Duration::from_secs(3_600);
        // only install with mods wins even if older
        assert_eq!(pick_recommended(&[(false, Some(now)), (true, Some(old))]), Some((1, "has your mods")));
        // no mods: clearly newer paks win; empty/fake install loses
        assert_eq!(pick_recommended(&[(false, Some(old)), (false, Some(now))]), Some((1, "most recently updated")));
        assert_eq!(pick_recommended(&[(false, None), (false, Some(old))]), Some((1, "most recently updated")));
        // both patched the same day: no confident pick
        assert_eq!(pick_recommended(&[(false, Some(recent)), (false, Some(now))]), None);
        // both have mods and same patch: no pick
        assert_eq!(pick_recommended(&[(true, Some(now)), (true, Some(recent))]), None);
        // nothing to go on
        assert_eq!(pick_recommended(&[(false, None), (false, None)]), None);
    }
}

/// Steam installation roots on Linux: native package, Flatpak and Snap.
#[cfg(target_os = "linux")]
pub fn linux_steam_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    [
        ".steam/steam",
        ".local/share/Steam",
        ".var/app/com.valvesoftware.Steam/.local/share/Steam",
        ".var/app/com.valvesoftware.Steam/.steam/steam",
        "snap/steam/common/.local/share/Steam",
        "snap/steam/common/.steam/steam",
    ]
    .iter()
    .map(|p| home.join(p))
    .collect()
}

/// Reads `libraryfolders.vdf` to find additional Steam libraries.
/// Enhanced to check registry and multiple common locations.
pub fn get_steam_library_paths() -> Vec<PathBuf> {
    let mut vdf_paths_to_check: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // Try to get Steam path from Windows registry first
        if let Some(steam_path) = get_steam_path_from_registry() {
            let vdf = steam_path.join("steamapps/libraryfolders.vdf");
            info!("Found Steam path from registry: {:?}", vdf);
            vdf_paths_to_check.push(vdf);
        }

        // Common Steam installation paths to check as fallbacks
        let common_paths = [
            "C:/Program Files (x86)/Steam",
            "C:/Program Files/Steam",
            "D:/Steam",
            "D:/Program Files (x86)/Steam",
            "D:/Program Files/Steam",
            "E:/Steam",
            "E:/SteamLibrary",
            "F:/Steam",
            "F:/SteamLibrary",
        ];

        for path in common_paths {
            let vdf = PathBuf::from(path).join("steamapps/libraryfolders.vdf");
            if !vdf_paths_to_check.contains(&vdf) {
                vdf_paths_to_check.push(vdf);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for root in linux_steam_roots() {
            vdf_paths_to_check.push(root.join("steamapps/libraryfolders.vdf"));
        }
    }

    // Read every VDF that exists: native, Flatpak and Snap Steam can be installed side
    // by side on Linux, each with its own library list.
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut found_vdf = false;

    for vdf_path in vdf_paths_to_check.into_iter().filter(|p| p.exists()) {
        found_vdf = true;
        info!("Using Steam library config: {:?}", vdf_path);

        let content = fs::read_to_string(&vdf_path).ok().unwrap_or_default();

        for line in content.lines() {
            if line.trim().starts_with("\"path\"") {
                let path = line
                    .split("\"")
                    .nth(3)
                    .map(|s| PathBuf::from(s.replace("\\\\", "\\")));
                info!("Found steam library path: {:?}", path);
                if let Some(p) = path {
                    if !paths.contains(&p) {
                        paths.push(p);
                    }
                }
            }
        }
    }

    if !found_vdf {
        info!("No Steam libraryfolders.vdf found");
    }

    paths
}

/// Get Steam installation path from Windows registry
#[cfg(target_os = "windows")]
fn get_steam_path_from_registry() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Query registry for Steam install path
    // reg query "HKCU\Software\Valve\Steam" /v SteamPath
    let output = Command::new("reg")
        .args(["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Parse output: "    SteamPath    REG_SZ    C:\Program Files (x86)\Steam"
    for line in stdout.lines() {
        if line.contains("SteamPath") && line.contains("REG_SZ") {
            // Split by REG_SZ and take the path part
            if let Some(path_part) = line.split("REG_SZ").nth(1) {
                let path = path_part.trim();
                if !path.is_empty() {
                    info!("Found Steam path in registry: {}", path);
                    return Some(PathBuf::from(path));
                }
            }
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn get_steam_path_from_registry() -> Option<PathBuf> {
    None
}
