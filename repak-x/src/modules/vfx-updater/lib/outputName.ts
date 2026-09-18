// VFX Updater - Output bundle naming

/**
 * Base name for the `_UPDATED` output bundle: the source file name without its
 * extension or `_<priority>_P` suffix, with whitespace replaced by underscores.
 */
export function updatedModBaseName(modPath: string): string {
  return modPath
    .split(/[\\/]/)
    .pop()!
    .replace(".utoc", "")
    .replace(/_\d+_P$/, "")
    .replace(/_P$/, "")
    .trim()
    .replace(/\s+/g, "_");
}

/** Output bundle path (no extension) for `modPath`, in `outputDir` or the game's ~mods folder. */
export function updatedModOutputBase(modPath: string, outputDir: string | null, gamePaksPath: string): string {
  const dir = outputDir || `${gamePaksPath}/~mods`;
  return `${dir}/${updatedModBaseName(modPath)}_UPDATED_9999999_P`;
}
