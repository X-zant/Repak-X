# Repak X — Changelog

## [2.1.0](https://github.com/X-zant/Repak-X/releases/latest)

### 🐧 Linux
- Linux builds and packaging
- App behavior is now tailored to Linux too: crash detection, app icon, clipboard, file paths and logs, etc.

### 🔧 Backend / Logic
- Security patches
- Renaming, moving or toggling a mod no longer overwrites another mod with the same name
- Renaming/moving a mod keeps its bundle files together, and undoes the change if one fails
- Your app data (tags, folders, settings) is now saved more safely, so a crash or power loss can no longer wipe it

### 🎨 Frontend / UI
- Mod sharing now shows live progress for the sender as well, with mods completed, transfer speed and time remaining for both sides
- Receivers are told when the sender stops sharing mid-transfer
- Minor UI fixes
