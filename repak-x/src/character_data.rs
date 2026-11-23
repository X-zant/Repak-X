// Character Data Management
// Handles external character_data.json in roaming folder with caching for performance
// Fetches updates from the Starsong GraphQL API (data.starsong.dev); the GitHub
// MarvelRivalsCharacterIDs fetcher is kept below as an unused backup source

use crate::ui_log;
use log::{info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

/// Scope tag for this module's log drawer entries.
const SCOPE: &str = "CharDB";

// === CHARACTER UPDATE CANCELLATION FLAG ===
// Global flag to signal cancellation of the character data fetch
static CANCEL_CHARACTER_UPDATE: AtomicBool = AtomicBool::new(false);

/// Request cancellation of the ongoing character data update
pub fn request_cancel_update() {
    CANCEL_CHARACTER_UPDATE.store(true, Ordering::SeqCst);
}

/// Check if cancellation was requested
pub fn is_update_cancelled() -> bool {
    CANCEL_CHARACTER_UPDATE.load(Ordering::SeqCst)
}

/// Reset the cancellation flag (call before starting a new update)
pub fn reset_cancel_flag() {
    CANCEL_CHARACTER_UPDATE.store(false, Ordering::SeqCst);
}

// ============================================================================
// STARSONG DATA SOURCE
// ============================================================================

const STARSONG_GRAPHQL_URL: &str = "https://data.starsong.dev/marvel-rivals/graphql";

/// Starsong asked for an identifiable User-Agent so it can trace its traffic.
const STARSONG_USER_AGENT: &str = concat!("RepakX/", env!("CARGO_PKG_VERSION"));

/// Part of the saved revision key: bump it whenever STARSONG_SKINS_QUERY changes,
/// otherwise an unchanged pin would skip fetching the new fields.
const STARSONG_QUERY_VERSION: &str = "v2";

/// Hero id Project Galacta mods are labelled with (see utils.rs / heroes.ts).
const GALACTA_HERO_ID: &str = "4017";

const STARSONG_SKINS_QUERY: &str = "{ revision { pin heroes(first: 100) { nodes { id name playable items(first: 100, type: [SKIN, SKIN_COLOR]) { nodes { id name } } } } } }";

// ============================================================================
// GITHUB DATA SOURCE (backup, currently unused)
// ============================================================================

#[allow(dead_code)]
const GITHUB_CHARACTER_DATA_URL: &str =
    "https://raw.githubusercontent.com/donutman07/MarvelRivalsCharacterIDs/main/MarvelRivalsCharacterIDs.md";

// ============================================================================
// DATA STRUCTURES
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterSkin {
    pub name: String,      // Character name
    pub id: String,        // Character ID (e.g., "1011" for Hulk)
    pub skinid: String,    // Skin ID (e.g., "1011001" for default)
    pub skin_name: String, // Skin display name
}

/// Cached character data for fast lookups
pub struct CharacterDataCache {
    /// All skins indexed by skin ID for O(1) lookup
    by_skin_id: HashMap<String, CharacterSkin>,
    /// Character IDs indexed by character name (name -> id)
    character_ids: HashMap<String, String>,
    /// Character names indexed by character ID (id -> name) for reverse lookup
    character_names: HashMap<String, String>,
    /// All skins as a list
    all_skins: Vec<CharacterSkin>,
    /// Whether the cache has been initialized
    initialized: bool,
}

impl Default for CharacterDataCache {
    fn default() -> Self {
        Self {
            by_skin_id: HashMap::new(),
            character_ids: HashMap::new(),
            character_names: HashMap::new(),
            all_skins: Vec::new(),
            initialized: false,
        }
    }
}

// Global cache with thread-safe access
static CHARACTER_CACHE: Lazy<Arc<RwLock<CharacterDataCache>>> =
    Lazy::new(|| Arc::new(RwLock::new(CharacterDataCache::default())));

// ============================================================================
// CHARACTER ID LOOKUP
// ============================================================================

/// Get character name from character ID (id -> name)
/// Uses the dynamically loaded character_data.json for lookups
/// Used for static mesh and audio mods that aren't skin-specific
pub fn get_character_name_from_id(char_id: &str) -> Option<String> {
    ensure_cache_initialized();

    let cache = CHARACTER_CACHE.read().unwrap();
    cache.character_names.get(char_id).cloned()
}

// ============================================================================
// FILE PATHS
// ============================================================================

/// Get the path to the character data JSON file in roaming folder
pub fn character_data_path() -> PathBuf {
    let app_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Repak-X");

    // Ensure directory exists
    let _ = fs::create_dir_all(&app_dir);

    app_dir.join("character_data.json")
}

/// Get the path to the bundled default character data (fallback)
pub fn bundled_character_data_path() -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let bundled = exe_dir.join("data").join("character_data.json");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }
    None
}

// ============================================================================
// DATA LOADING / SAVING
// ============================================================================

/// Load character data from external JSON file
pub fn load_character_data() -> Vec<CharacterSkin> {
    let path = character_data_path();

    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Vec<CharacterSkin>>(&contents) {
                Ok(mut skins) => {
                    info!(
                        "Loaded {} character skins from {}",
                        skins.len(),
                        path.display()
                    );
                    if migrate_renamed_heroes(&mut skins) {
                        // Persist so the rename runs once
                        let _ = save_character_data(&skins);
                        DETAILS_STALE.store(true, Ordering::SeqCst);
                    }
                    return skins;
                }
                Err(e) => {
                    warn!("Failed to parse character data: {}", e);
                }
            },
            Err(e) => {
                warn!("Failed to read character data file: {}", e);
            }
        }
    }

    // Try bundled fallback
    if let Some(bundled_path) = bundled_character_data_path() {
        if let Ok(contents) = fs::read_to_string(&bundled_path) {
            if let Ok(skins) = serde_json::from_str::<Vec<CharacterSkin>>(&contents) {
                info!("Loaded {} character skins from bundled file", skins.len());
                // Save to external location for future use
                let _ = save_character_data(&skins);
                return skins;
            }
        }
    }

    info!("No character data found, returning empty list");
    Vec::new()
}

/// Set when loading renamed heroes in the saved data, so the cached mod details
/// (which embed hero names) get cleared. Cleared lazily by `take_details_stale`
/// rather than here, because loading can run while the mod database is locked.
static DETAILS_STALE: AtomicBool = AtomicBool::new(false);

/// Returns true once after renamed heroes were loaded.
pub fn take_details_stale() -> bool {
    ensure_cache_initialized();
    DETAILS_STALE.swap(false, Ordering::SeqCst)
}

/// Rename heroes whose display name changed in saved data files (users keep their
/// own copy in the config folder, so editing the bundled JSON alone doesn't reach them).
/// Returns whether anything was renamed.
fn migrate_renamed_heroes(skins: &mut [CharacterSkin]) -> bool {
    let mut changed = false;
    for skin in skins.iter_mut() {
        let renamed = match skin.name.as_str() {
            "Punisher" => "The Punisher",
            "Iron Fist (lin Lie)" => "Iron Fist",
            // Old local names -> the API's, until the first update rewrites the file
            "Hulk" => "Bruce Banner",
            "Jeff the Landshark" => "Jeff The Land Shark",
            "Gorr" => "Gorr The God Butcher",
            _ => continue,
        };
        skin.name = renamed.to_string();
        changed = true;
    }
    changed
}

/// Save character data to external JSON file with backup and sorting
pub fn save_character_data(skins: &[CharacterSkin]) -> Result<(), String> {
    let path = character_data_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    // One backup, overwritten each save
    if path.exists() {
        let backup_path = path.with_file_name("character_data_backup.json");
        if let Err(e) = fs::copy(&path, &backup_path) {
            warn!("Failed to create backup: {}", e);
        } else {
            info!("Created backup at {}", backup_path.display());
        }
    }
    // Older versions wrote a timestamped backup on every save; remove those
    if let Some(entries) = path.parent().and_then(|dir| fs::read_dir(dir).ok()) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("character_data_backup_") && name.ends_with(".json") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    // Sort skins before saving for consistent output
    let mut sorted_skins = skins.to_vec();
    sorted_skins.sort_by(|a, b| {
        // Parse IDs as numbers for proper numeric sorting
        let a_char_id: u32 = a.id.parse().unwrap_or(0);
        let b_char_id: u32 = b.id.parse().unwrap_or(0);
        let a_skin_id: u32 = a.skinid.parse().unwrap_or(0);
        let b_skin_id: u32 = b.skinid.parse().unwrap_or(0);

        a_char_id
            .cmp(&b_char_id)
            .then(a_skin_id.cmp(&b_skin_id))
            .then(a.skin_name.cmp(&b.skin_name))
    });

    let json = serde_json::to_string_pretty(&sorted_skins)
        .map_err(|e| format!("Failed to serialize data: {}", e))?;

    fs::write(&path, json).map_err(|e| format!("Failed to write file: {}", e))?;

    info!(
        "Saved {} character skins to {}",
        sorted_skins.len(),
        path.display()
    );
    Ok(())
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

/// Initialize or refresh the character data cache
pub fn refresh_cache() {
    let skins = load_character_data();

    let mut cache = CHARACTER_CACHE.write().unwrap();
    cache.by_skin_id.clear();
    cache.character_ids.clear();
    cache.character_names.clear();
    cache.all_skins.clear();

    for skin in &skins {
        cache.by_skin_id.insert(skin.skinid.clone(), skin.clone());
        cache
            .character_ids
            .insert(skin.name.clone(), skin.id.clone());
        // Also populate reverse lookup (id -> name)
        cache
            .character_names
            .insert(skin.id.clone(), skin.name.clone());
    }

    cache.all_skins = skins;
    cache.initialized = true;

    info!(
        "Character data cache refreshed: {} skins, {} characters",
        cache.by_skin_id.len(),
        cache.character_ids.len()
    );
}

/// Ensure cache is initialized (lazy initialization)
fn ensure_cache_initialized() {
    let needs_init = {
        let cache = CHARACTER_CACHE.read().unwrap();
        !cache.initialized
    };

    if needs_init {
        refresh_cache();
    }
}

/// Get character info by skin ID (fast cached lookup)
pub fn get_character_by_skin_id(skin_id: &str) -> Option<CharacterSkin> {
    ensure_cache_initialized();

    let cache = CHARACTER_CACHE.read().unwrap();
    cache.by_skin_id.get(skin_id).cloned()
}

/// Get all character data
pub fn get_all_character_data() -> Vec<CharacterSkin> {
    ensure_cache_initialized();

    let cache = CHARACTER_CACHE.read().unwrap();
    cache.all_skins.clone()
}
// NAME NORMALIZATION
// ============================================================================

/// Normalize skin name - convert all-caps to title case
/// Preserves intentional capitalization like "2099", "VFX", acronyms, etc.
fn normalize_skin_name(raw_name: &str) -> String {
    let trimmed = raw_name.trim();

    // If it's not all caps (has at least one lowercase letter), keep as-is
    if trimmed.chars().any(|c| c.is_lowercase()) {
        return trimmed.to_string();
    }

    // It's all caps - convert to title case, but preserve certain patterns
    let words: Vec<String> = trimmed
        .split_whitespace()
        .map(|word| {
            // Preserve numbers and special patterns
            if word
                .chars()
                .all(|c| c.is_numeric() || c == '\'' || c == '-' || c == '&')
            {
                return word.to_string();
            }

            // Preserve common acronyms and special terms
            match word {
                "VFX" | "SFX" | "UI" | "MVP" | "AI" | "AIM" | "IGNITE" => word.to_string(),
                "2099" | "1872" => word.to_string(),
                // Convert to title case
                _ => {
                    let mut result = String::new();
                    let mut first = true;
                    for c in word.chars() {
                        if first {
                            result.push_str(&c.to_uppercase().to_string());
                            first = false;
                        } else {
                            result.push_str(&c.to_lowercase().to_string());
                        }
                    }
                    result
                }
            }
        })
        .collect();

    words.join(" ")
}

/// Normalize character name to proper capitalization
/// Handles special cases and ensures proper formatting
fn normalize_character_name(raw_name: &str) -> String {
    let lower = raw_name.to_lowercase();
    let trimmed = lower.trim();

    // Special cases that need exact formatting
    match trimmed {
        "the punisher" | "punisher" => "The Punisher".to_string(),
        "the thing" => "The Thing".to_string(),
        "cloak and dagger" | "cloak & dagger" => "Cloak & Dagger".to_string(),
        "jeff the landshark" | "jeff the land shark" => "Jeff the Landshark".to_string(),
        "spider-man" | "spider man" | "spiderman" => "Spider-Man".to_string(),
        "star-lord" | "star lord" | "starlord" => "Star-Lord".to_string(),
        "iron man" | "ironman" => "Iron Man".to_string(),
        "iron fist" | "ironfist" => "Iron Fist".to_string(),
        "black panther" => "Black Panther".to_string(),
        "black widow" => "Black Widow".to_string(),
        "moon knight" => "Moon Knight".to_string(),
        "luna snow" => "Luna Snow".to_string(),
        "squirrel girl" => "Squirrel Girl".to_string(),
        "human torch" => "Human Torch".to_string(),
        "doctor strange" | "dr strange" | "dr. strange" => "Doctor Strange".to_string(),
        "captain america" => "Captain America".to_string(),
        "rocket raccoon" => "Rocket Raccoon".to_string(),
        "mister fantastic" | "mr fantastic" | "mr. fantastic" => "Mister Fantastic".to_string(),
        "winter soldier" => "Winter Soldier".to_string(),
        "peni parker" => "Peni Parker".to_string(),
        "adam warlock" => "Adam Warlock".to_string(),
        "invisible woman" => "Invisible Woman".to_string(),
        "emma frost" => "Emma Frost".to_string(),
        "scarlet witch" => "Scarlet Witch".to_string(),
        // Simple single-word names
        "hulk" => "Hulk".to_string(),
        "storm" => "Storm".to_string(),
        "loki" => "Loki".to_string(),
        "mantis" => "Mantis".to_string(),
        "hawkeye" => "Hawkeye".to_string(),
        "hela" => "Hela".to_string(),
        "groot" => "Groot".to_string(),
        "ultron" => "Ultron".to_string(),
        "magik" => "Magik".to_string(),
        "venom" => "Venom".to_string(),
        "magneto" => "Magneto".to_string(),
        "thor" => "Thor".to_string(),
        "blade" => "Blade".to_string(),
        "namor" => "Namor".to_string(),
        "psylocke" => "Psylocke".to_string(),
        "wolverine" => "Wolverine".to_string(),
        "phoenix" => "Phoenix".to_string(),
        "daredevil" => "Daredevil".to_string(),
        "angela" => "Angela".to_string(),
        "gambit" => "Gambit".to_string(),
        "rogue" => "Rogue".to_string(),
        _ => {
            // Fallback: title case each word
            raw_name
                .split_whitespace()
                .map(|word| {
                    let mut chars = word.chars();
                    match chars.next() {
                        None => String::new(),
                        Some(first) => first
                            .to_uppercase()
                            .chain(chars.map(|c| c.to_lowercase().next().unwrap()))
                            .collect(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        }
    }
}

// ============================================================================
// VALIDATION
// ============================================================================

/// Validate a CharacterSkin entry
fn validate_skin(skin: &CharacterSkin) -> Result<(), String> {
    // Check character ID is 4 digits
    if skin.id.len() != 4 || !skin.id.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!(
            "Invalid character ID '{}' for {}",
            skin.id, skin.name
        ));
    }

    // Check skin ID is 7 digits
    if skin.skinid.len() != 7 || !skin.skinid.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!(
            "Invalid skin ID '{}' for {} - {}",
            skin.skinid, skin.name, skin.skin_name
        ));
    }

    // Check skin ID starts with character ID
    if !skin.skinid.starts_with(&skin.id) {
        return Err(format!(
            "Skin ID '{}' doesn't start with character ID '{}' for {} - {}",
            skin.skinid, skin.id, skin.name, skin.skin_name
        ));
    }

    // Check names are not empty
    if skin.name.trim().is_empty() || skin.skin_name.trim().is_empty() {
        return Err(format!("Empty name fields for skin ID {}", skin.skinid));
    }

    Ok(())
}

// ============================================================================
// GITHUB DATA FETCHER
// ============================================================================

/// Parse GitHub Markdown file and extract character data
/// Format: Markdown table with | ID | NAME | SKIN IDs | SKIN NAMES |
/// Empty cells (| | |) mean "same as previous row"
#[allow(dead_code)]
fn parse_github_markdown(content: &str) -> Result<Vec<CharacterSkin>, String> {
    info!("=== Starting GitHub Markdown Parse ===");
    info!("Content length: {} bytes", content.len());
    info!("Total lines: {}", content.lines().count());

    let mut skins = Vec::new();
    let mut line_num = 0;
    let mut errors = Vec::new();
    let mut processed_lines = 0;
    let mut skipped_lines = 0;

    // Track current character for rows with empty ID/name cells
    let mut current_char_id = String::new();
    let mut current_char_name = String::new();

    // Regex to extract table cells - matches content between pipes
    // This is more robust than splitting by | because it handles missing trailing pipes
    let cell_regex = regex_lite::Regex::new(r"\|([^|]*)").unwrap();

    for line in content.lines() {
        line_num += 1;
        let line = line.trim();

        // Skip empty lines, headers, and separator lines
        if line.is_empty() || line.starts_with('#') || line.contains(":--:") {
            skipped_lines += 1;
            continue;
        }

        // Only process lines that look like table rows
        if !line.starts_with('|') {
            skipped_lines += 1;
            continue;
        }

        processed_lines += 1;

        // Extract all cells using regex
        let cells: Vec<String> = cell_regex
            .captures_iter(line)
            .map(|cap| cap.get(1).unwrap().as_str().trim().to_string())
            .collect();

        // Need exactly 4 cells: char_id, char_name, skin_id, skin_name
        if cells.len() < 4 {
            if processed_lines <= 10 {
                info!(
                    "Line {}: Skipping - found {} cells: {:?}",
                    line_num,
                    cells.len(),
                    cells
                );
            }
            continue;
        }

        let char_id_cell = &cells[0];
        let char_name_cell = &cells[1];
        let skin_id = &cells[2];
        let skin_name = &cells[3];

        if processed_lines <= 10 {
            info!(
                "Line {}: Processing - ID:'{}' Name:'{}' SkinID:'{}' SkinName:'{}'",
                line_num, char_id_cell, char_name_cell, skin_id, skin_name
            );
        }

        // If char_id cell is not empty, update current character
        if !char_id_cell.is_empty() {
            // Validate it's a proper 4-digit ID
            if char_id_cell.len() == 4 && char_id_cell.chars().all(|c| c.is_ascii_digit()) {
                current_char_id = char_id_cell.to_string();
            }
        }

        // If char_name cell is not empty, update current character name
        if !char_name_cell.is_empty() {
            current_char_name = char_name_cell.to_string();
        }

        // Skip if we don't have a current character yet
        if current_char_id.is_empty() || current_char_name.is_empty() {
            continue;
        }

        // Validate skin ID
        if skin_id.len() != 7 || !skin_id.chars().all(|c| c.is_ascii_digit()) {
            errors.push(format!("Line {}: Invalid skin ID '{}'", line_num, skin_id));
            continue;
        }

        // Skip if skin name is empty
        if skin_name.is_empty() {
            continue;
        }

        // Normalize character name for consistent capitalization
        let char_name = normalize_character_name(&current_char_name);

        // Normalize skin name - convert all-caps to title case, but preserve intentional caps
        let normalized_skin_name = normalize_skin_name(skin_name);

        let skin = CharacterSkin {
            name: char_name,
            id: current_char_id.clone(),
            skinid: skin_id.to_string(),
            skin_name: normalized_skin_name,
        };

        // Validate the skin
        if let Err(e) = validate_skin(&skin) {
            errors.push(format!("Line {}: {}", line_num, e));
            continue;
        }

        skins.push(skin);
    }

    info!("=== Parse Complete ===");
    info!("Processed lines: {}", processed_lines);
    info!("Skipped lines: {}", skipped_lines);
    info!("Total skins extracted: {}", skins.len());
    info!("Validation errors: {}", errors.len());

    // Log sample of what we got
    if skins.len() > 0 {
        info!(
            "First skin: {} - {} ({})",
            skins[0].name, skins[0].skin_name, skins[0].skinid
        );
        if skins.len() > 1 {
            info!(
                "Last skin: {} - {} ({})",
                skins[skins.len() - 1].name,
                skins[skins.len() - 1].skin_name,
                skins[skins.len() - 1].skinid
            );
        }
    }

    if !errors.is_empty() {
        warn!(
            "Encountered {} validation errors while parsing:",
            errors.len()
        );
        for error in errors.iter().take(10) {
            warn!("  {}", error);
        }
        if errors.len() > 10 {
            warn!("  ... and {} more errors", errors.len() - 10);
        }
    }

    if skins.is_empty() {
        return Err("No skins were successfully parsed from GitHub data".to_string());
    }

    info!(
        "Successfully parsed {} character skins from GitHub",
        skins.len()
    );
    Ok(skins)
}

/// Fetch character data from GitHub with progress callback and cancellation support
#[allow(dead_code)]
pub async fn fetch_github_data_with_progress<F>(
    on_progress: &mut F,
) -> Result<Vec<CharacterSkin>, String>
where
    F: FnMut(&str) + Send,
{
    // Reset cancellation flag at start
    reset_cancel_flag();

    let client = reqwest::Client::builder()
        .user_agent("Repak-X/1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    on_progress("Connecting to GitHub...");
    info!(
        "Fetching character data from GitHub: {}",
        GITHUB_CHARACTER_DATA_URL
    );

    // Check for cancellation
    if is_update_cancelled() {
        on_progress("Update cancelled by user");
        return Err("Cancelled".to_string());
    }

    // Fetch the markdown file
    let response = client
        .get(GITHUB_CHARACTER_DATA_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch GitHub data: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("GitHub returned status: {}", response.status()));
    }

    on_progress("Downloading character data...");

    let content = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // Check for cancellation before parsing
    if is_update_cancelled() {
        on_progress("Update cancelled by user");
        return Err("Cancelled".to_string());
    }

    on_progress("Parsing character data...");
    on_progress(&format!(
        "Downloaded {} bytes, {} lines",
        content.len(),
        content.lines().count()
    ));

    let skins = parse_github_markdown(&content)?;

    on_progress(&format!("Parse complete: {} skins extracted", skins.len()));
    on_progress(&format!(
        "Successfully fetched {} character skins",
        skins.len()
    ));
    info!(
        "Successfully fetched {} character skins from GitHub",
        skins.len()
    );

    Ok(skins)
}

// ============================================================================
// STARSONG DATA FETCHER
// ============================================================================

fn starsong_pin_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Repak-X")
        .join("character_data_starsong_pin.txt")
}

/// Run a GraphQL query and return its `data`.
/// Uses GET because the API only caches GET requests.
async fn starsong_query(
    client: &reqwest::Client,
    query: &str,
    at: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut request = client
        .get(STARSONG_GRAPHQL_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .query(&[("query", query)]);
    if let Some(pin) = at {
        request = request.query(&[("at", pin)]);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to reach Psylocke.gg API: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Psylocke.gg API returned status: {}", response.status()));
    }

    let mut body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to read Psylocke.gg response: {}", e))?;

    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()) {
        if !errors.is_empty() {
            return Err(format!("Psylocke.gg API error: {}", serde_json::Value::from(errors.clone())));
        }
    }

    match body.get_mut("data") {
        Some(data) if !data.is_null() => Ok(data.take()),
        _ => Err("Psylocke.gg response had no data".to_string()),
    }
}

/// Turn the heroes/items response into CharacterSkin rows, using the API's hero
/// names (e.g. 1011 is "Bruce Banner").
fn parse_starsong_heroes(data: &serde_json::Value) -> Result<Vec<CharacterSkin>, String> {
    let heroes = data
        .pointer("/revision/heroes/nodes")
        .and_then(|n| n.as_array())
        .ok_or("Psylocke.gg response is missing revision.heroes.nodes")?;

    let mut skins = Vec::new();
    for hero in heroes {
        let (Some(char_id), Some(api_name)) = (
            hero.get("id").and_then(|v| v.as_str()),
            hero.get("name").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let playable = hero.get("playable").and_then(|v| v.as_bool()).unwrap_or(false);

        // Non-playable rows are NPCs and internal placeholders (some named in Chinese).
        // Galacta is the exception: Project Galacta (WBP_Galacta) mods are labelled
        // with its id, and the API calls it "Lobby Npc - Galacta".
        let char_name = if char_id == GALACTA_HERO_ID {
            "Galacta".to_string()
        } else if !playable {
            continue;
        } else {
            api_name.trim().to_string()
        };

        let items = hero
            .pointer("/items/nodes")
            .and_then(|n| n.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        for item in items {
            let (Some(item_id), Some(item_name)) = (
                item.get("id").and_then(|v| v.as_str()),
                item.get("name").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            // SKIN_COLOR items are "ps" + the 7-digit skin id the paks use.
            let skin_id = item_id.strip_prefix("ps").unwrap_or(item_id);
            // The database names every base skin "Default"; the API repeats the hero name.
            let skin_name = if skin_id.ends_with("001") {
                "Default".to_string()
            } else {
                normalize_skin_name(item_name)
            };

            let skin = CharacterSkin {
                name: char_name.clone(),
                id: char_id.to_string(),
                skinid: skin_id.to_string(),
                skin_name,
            };
            match validate_skin(&skin) {
                Ok(()) => skins.push(skin),
                Err(e) => warn!("Skipping Psylocke.gg item {}: {}", item_id, e),
            }
        }
    }

    if skins.is_empty() {
        return Err("No skins were parsed from Psylocke.gg data".to_string());
    }
    Ok(skins)
}

/// Fetch character data from the Starsong API with progress and cancellation.
/// Returns Ok(None) when the revision matches `saved_key` (nothing changed);
/// otherwise the new revision key (to save after a successful write) and the skins.
async fn fetch_starsong_data_with_progress<F>(
    on_progress: &mut F,
    saved_key: Option<&str>,
) -> Result<Option<(String, Vec<CharacterSkin>)>, String>
where
    F: FnMut(&str) + Send,
{
    reset_cancel_flag();

    let client = reqwest::Client::builder()
        .user_agent(STARSONG_USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    on_progress("Checking Psylocke.gg data revision...");
    let data = starsong_query(&client, "{ revision { pin } }", None).await?;
    let pin = data
        .pointer("/revision/pin")
        .and_then(|p| p.as_str())
        .ok_or("Psylocke.gg response is missing revision.pin")?
        .to_string();
    let key = format!("{}:{}", STARSONG_QUERY_VERSION, pin);
    info!("Psylocke.gg revision: {}", pin);

    if saved_key == Some(key.as_str()) {
        on_progress(&format!("Already on Psylocke.gg revision {}", pin));
        return Ok(None);
    }

    if is_update_cancelled() {
        on_progress("Update cancelled by user");
        return Err("Cancelled".to_string());
    }

    on_progress(&format!("Downloading character data (revision {})...", pin));
    // Pinned so this reads the exact revision checked above; pinned responses never change.
    let data = starsong_query(&client, STARSONG_SKINS_QUERY, Some(&pin)).await?;

    if is_update_cancelled() {
        on_progress("Update cancelled by user");
        return Err("Cancelled".to_string());
    }

    let skins = parse_starsong_heroes(&data)?;
    on_progress(&format!("Fetched {} character skins", skins.len()));
    info!("Fetched {} character skins from Psylocke.gg", skins.len());
    Ok(Some((key, skins)))
}

/// Update character data from the Starsong API with progress callback
/// (fetches, validates, saves, refreshes cache)
pub async fn update_character_data_with_progress<F>(mut on_progress: F) -> Result<usize, String>
where
    F: FnMut(&str) + Send,
{
    // Load existing data - only from roaming folder, not bundled
    // This prevents creating a backup of bundled data that was just copied
    let path = character_data_path();
    let existing = if path.exists() {
        match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Vec<CharacterSkin>>(&contents) {
                Ok(mut skins) => {
                    info!(
                        "Loaded {} existing skins from {}",
                        skins.len(),
                        path.display()
                    );
                    migrate_renamed_heroes(&mut skins);
                    skins
                }
                Err(e) => {
                    warn!("Failed to parse existing character data: {}", e);
                    Vec::new()
                }
            },
            Err(e) => {
                warn!("Failed to read existing character data: {}", e);
                Vec::new()
            }
        }
    } else {
        info!("No existing character data file found");
        Vec::new()
    };
    let existing_count = existing.len();

    // Only trust the saved revision while the data file it produced still exists.
    let saved_key = if path.exists() {
        fs::read_to_string(starsong_pin_path())
            .ok()
            .map(|s| s.trim().to_string())
    } else {
        None
    };
    let Some((revision_key, new_skins)) =
        fetch_starsong_data_with_progress(&mut on_progress, saved_key.as_deref()).await?
    else {
        return Ok(0);
    };

    on_progress(&format!("Validating {} fetched skins...", new_skins.len()));

    // Validate all skins
    let mut validation_errors = 0;
    for skin in &new_skins {
        if let Err(e) = validate_skin(skin) {
            warn!("Validation error: {}", e);
            validation_errors += 1;
        }
    }

    if validation_errors > 0 {
        warn!(
            "Found {} validation errors in fetched data",
            validation_errors
        );
    }

    // The API is the source of truth: the file is rewritten from it, not merged,
    // so skins the API dropped (placeholders, unreleased heroes) go away too.
    let existing_ids: std::collections::HashSet<&str> =
        existing.iter().map(|s| s.skinid.as_str()).collect();
    let new_count = new_skins
        .iter()
        .filter(|s| !existing_ids.contains(s.skinid.as_str()))
        .count();
    let total_count = new_skins.len();
    // A rewrite replaces everything, so refuse an answer that lost most of the
    // data (e.g. a schema change emptying a field) instead of wiping the database.
    if total_count < existing_count / 2 {
        return Err(format!(
            "Psylocke.gg returned only {} skins (had {}), keeping existing data",
            total_count, existing_count
        ));
    }

    on_progress(&format!("Saving {} character skins to disk...", total_count));
    save_character_data(&new_skins)?;
    if let Err(e) = fs::write(starsong_pin_path(), &revision_key) {
        warn!("Failed to save Psylocke.gg revision: {}", e);
    }
    // Cached mod details embed hero names from the old data.
    if let Err(e) = crate::mod_db::db().clear_details() {
        warn!("Failed to clear cached mod details: {}", e);
    }

    on_progress("Refreshing cache...");
    refresh_cache();

    info!(
        "Update complete: {} total skins ({} before), {} new",
        total_count, existing_count, new_count
    );
    Ok(new_count)
}

// ============================================================================
// AUTO-UPDATE ON LAUNCH (throttled to once per day)
// ============================================================================

use std::time::{SystemTime, UNIX_EPOCH};

const AUTO_UPDATE_CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

fn last_check_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Repak-X")
        .join("character_data_last_check.txt")
}

fn read_last_check_time() -> Option<u64> {
    fs::read_to_string(last_check_path())
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
}

fn write_last_check_time() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = fs::write(last_check_path(), now.to_string());
}

fn should_check_for_update() -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    match read_last_check_time() {
        Some(last) => now.saturating_sub(last) >= AUTO_UPDATE_CHECK_INTERVAL_SECS,
        None => true,
    }
}

/// Check for character data updates at app launch, throttled to once per day.
/// Silently no-ops if a check already happened recently. Returns the number
/// of newly-added skins if an update was performed and it added anything.
pub async fn check_for_update_on_launch() -> Option<usize> {
    if !should_check_for_update() {
        // Reported rather than skipped silently: "it never checks" was the
        // impression this branch left, because nothing said the check had
        // already happened.
        ui_log::info(
            SCOPE,
            match hours_until_next_check() {
                Some(0) => "Character database checked recently, next check due shortly".to_string(),
                Some(hours) => format!(
                    "Character database checked recently, next check in ~{}h",
                    hours
                ),
                None => "Character database checked recently, skipping".to_string(),
            },
        );
        return None;
    }

    ui_log::info(SCOPE, "Checking character database for updates...");
    // Record the check time up-front so a failure (e.g. offline) doesn't
    // cause a retry on every subsequent launch until the interval passes.
    write_last_check_time();

    match update_character_data_with_progress(|_msg| {}).await {
        Ok(new_count) => {
            let total = get_all_character_data().len();
            if new_count > 0 {
                ui_log::success(
                    SCOPE,
                    format!(
                        "Character database updated: {} new skin(s) ({} total)",
                        new_count, total
                    ),
                );
                Some(new_count)
            } else {
                ui_log::success(
                    SCOPE,
                    format!("Character database is up to date ({} skins)", total),
                );
                None
            }
        }
        Err(e) => {
            // Not an error for the user: the bundled/cached database still
            // works, they just will not see skins added since it was written.
            ui_log::warn(
                SCOPE,
                format!("Character database check failed ({}) - using cached data", e),
            );
            None
        }
    }
}

/// Whole hours left on the once-per-day throttle, for the skip message.
fn hours_until_next_check() -> Option<u64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .ok()?;
    let last = read_last_check_time()?;
    let elapsed = now.saturating_sub(last);
    Some(AUTO_UPDATE_CHECK_INTERVAL_SECS.saturating_sub(elapsed) / 3600)
}

// ============================================================================
// UTILITY FUNCTIONS FOR MOD TYPE DETECTION
// ============================================================================

/// Try to determine character/skin info from a mod's file paths
/// Returns (character_name, skin_name) if found
pub fn identify_mod_from_paths(file_paths: &[String]) -> Option<(String, String)> {
    ensure_cache_initialized();

    // Look for skin ID patterns in file paths
    // Common patterns: /1011001/, /Hero/1011/, etc.
    let skin_id_regex = regex_lite::Regex::new(r"(\d{7})").unwrap();
    let hero_id_regex = regex_lite::Regex::new(r"/(?:Hero|Characters?)/(\d{4})/").unwrap();

    let cache = CHARACTER_CACHE.read().unwrap();

    for path in file_paths {
        // Try to find exact skin ID
        for caps in skin_id_regex.captures_iter(path) {
            if let Some(m) = caps.get(1) {
                let potential_id = m.as_str();
                if let Some(skin) = cache.by_skin_id.get(potential_id) {
                    return Some((skin.name.clone(), skin.skin_name.clone()));
                }
            }
        }

        // Try to find character ID
        if let Some(caps) = hero_id_regex.captures(path) {
            if let Some(m) = caps.get(1) {
                let char_id = m.as_str();
                // Find any skin with this character ID
                for skin in cache.all_skins.iter() {
                    if skin.id == char_id {
                        return Some((skin.name.clone(), "Unknown Skin".to_string()));
                    }
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_starsong_heroes_maps_ids_and_names() {
        let data = serde_json::json!({ "revision": { "heroes": { "nodes": [
            { "id": "1011", "name": "Bruce Banner", "playable": true, "items": { "nodes": [
                { "id": "1011001", "name": "Bruce Banner" },
                { "id": "1011300", "name": "Maestro" },
                { "id": "ps1011504", "name": "Emerald Rage" },
                { "id": "1011999", "name": null }
            ] } },
            { "id": "9999", "name": "英雄零", "playable": false, "items": { "nodes": [
                { "id": "9999001", "name": "x" }
            ] } },
            { "id": "4017", "name": "Lobby Npc - Galacta", "playable": false, "items": { "nodes": [
                { "id": "4017001", "name": "大厅npc-伽娜塔" }
            ] } }
        ] } } });
        let skins = parse_starsong_heroes(&data).unwrap();
        let rows: Vec<_> = skins
            .iter()
            .map(|s| (s.name.as_str(), s.skinid.as_str(), s.skin_name.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("Bruce Banner", "1011001", "Default"),
                ("Bruce Banner", "1011300", "Maestro"),
                ("Bruce Banner", "1011504", "Emerald Rage"),
                ("Galacta", "4017001", "Default"),
            ]
        );
    }
}
