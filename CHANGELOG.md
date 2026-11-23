# Repak X — Changelog

## [2.4.0](https://github.com/X-zant/Repak-X/releases/latest)

### 🗃️ Mods Database
- Added a local mods database: tags now follow a mod through toggles, renames, moves, updates and restores, and same-named mods in different folders no longer share them.
- Added Profiles: save which mods are enabled as a named profile and switch between them from the action bar. Switches only change the mods that differ and ask about new mods. Double-click to rename.
- Mods renamed or moved outside Repak X are recognized again on the next scan.
- Mod details are now cached between launches, allowing for faster startup.

### 🔧 Backend / Logic
- Added Galacta Mode: only the mods the game has loaded stay locked while it runs. (Requires Project Galacta v1.6.0, can be toggled in Settings)
- Deleted mods now go to Recently deleted and can be restored for a set number of days. (Can be toggled in Settings)
- Check Conflicts now detects mod duplicates.
- Improved game path detection and added support for Loading Bay launcher.
- When multiple game installations are found, you can now pick which one to use, with a recommended pick.
- The heroes database now updates from psylocke.gg.
- Mod operations bug fixes.

### 🎨 Frontend / UI
- Mods can now be moved by dragging them onto a folder in the folder tree.
- Added a UI Scale setting.
- Added a search bar to Settings.
- The batch controls bar now floats at the bottom of the mods list.
- Added a mods Properties filter: enabled/disabled, and mod formats.
- Modals and the right-click menu are now fully usable with the keyboard.
- Settings now auto-save when changes are made.
- Mods dropped on the empty area of Quick Organize now install to the currently viewed folder instead of the root.
- Improved Light Mode readability.
- Added a Monochrome accent color: white in Dark Mode, black in Light Mode.
- Performance optimizations.
