# Repak X — Changelog

## [2.0.0](https://github.com/XzantGaming/Repak-X/releases/latest)

### 🔧 Backend / Logic
- Added Project Galacta integration: easy updates with automatic detection
- VFX Updater now ports scalar parameters as well (this allow updates of materials edits done with Atelier to be accurate)
- Fixed a Discord connection bug that caused a delayed app launch
- Characters database is now checked at app startup once per day
- Mod archives are now deleted after a successful extension install
- Fixed selecting multiple mods and using "Move to..." only moving the right-clicked one
- Dropping mods onto the empty Quick Organize panel now falls back to installing to the root folder
- Fixed a few install issues
- Fixed VFX Updater issues
- Improved mod list caching

### 🎨 Frontend / UI
- Added Asset Explorer, an extended viewer for mod file contents
- Redesigned the Settings panel with a categorized left sidebar picker
- Redesigned the Tools panel as a widget grid
- Added a quick mod toggle for Project Galacta in the Tools panel
- Redesigned the batch controls of the mods list, again
- Redesigned the extension install overlay and added organize options (rename, pick, flatten and more)
- Reworked the log drawer, it now also reports important events like the heroes database and icons checks
- Added extra animations to UI elements (can be toggled in settings)
- Mod Conflicts panel now allows to toggle the conflicting mods
- Fixed batch selection not being restored after moving mods
- Fixed the 2s delete safeguard not being disabled for the folder context menu
- Removed Character LODs Disabler toggle (mod is now deprecated)
- Fixed several UI issues and streamlined design
