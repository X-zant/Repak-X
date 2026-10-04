/**
 * Mod-related utility functions
 */

/**
 * Counts the mods a list of dropped paths represents.
 * An IoStore bundle (.pak + .utoc + .ucas sharing a name) is one mod, not three.
 *
 * @param {string[]} paths - Dropped file/folder paths
 * @returns {number} Number of distinct mods
 */
export function countModsInPaths(paths: string[]): number {
    const mods = new Set<string>();
    for (const path of paths) {
        mods.add(path.toLowerCase().replace(/\.(pak|utoc|ucas)$/, ''));
    }
    return mods.size;
}

type ModDetails = {
    additional_categories?: string[];
    mod_type?: string;
};

/**
 * Extracts additional categories from mod details
 * Categories can come from additional_categories array or mod_type string
 * 
 * @param {Object} details - Mod details object
 * @returns {string[]} Array of additional category strings
 */
export function getAdditionalCategories(details?: ModDetails | null): string[] {
    if (!details) return [];

    // Direct additional_categories array
    if (details.additional_categories && details.additional_categories.length > 0) {
        return details.additional_categories;
    }

    // Parse from mod_type string (e.g., "Skin [Blueprint, VFX]")
    if (typeof details.mod_type === 'string') {
        const match = details.mod_type.match(/\[(.*?)\]/);
        if (match && match[1]) {
            return match[1].split(',').map((s: string) => s.trim());
        }
    }

    return [];
}
