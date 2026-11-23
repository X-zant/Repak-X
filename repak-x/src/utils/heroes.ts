/**
 * Hero/character detection utilities
 */

/** Hero id Repak-X assigns to Project Galacta (via its WBP_Galacta asset). */
export const PROJECT_GALACTA_HERO_ID = '4017';

/**
 * Detects hero names from a list of file paths, using the live character data
 * (App state) so names match the database the backend uses.
 * 
 * @param {string[]} files - Array of file paths
 * @param {Object[]} characterData - Character data array
 * @returns {string[]} Array of detected hero names
 */
export function detectHeroesWithData(files: string[], characterData: any[]): string[] {
    const heroIds = new Set<string>();

    const pathRegex = /(?:Characters|Hero_ST|Hero)\/(\d{4})/;
    const filenameRegex = /[_/](10[1-6]\d)(\d{3})/;

    files.forEach(file => {
        // WBP_Galacta has no numeric hero ID in its path/filename, so it's
        // special-cased directly by name (mirrors backend logic).
        if (file.toLowerCase().includes('wbp_galacta')) {
            heroIds.add(PROJECT_GALACTA_HERO_ID);
            return;
        }

        const pathMatch = file.match(pathRegex);
        if (pathMatch) {
            heroIds.add(pathMatch[1]);
            return;
        }

        const filename = file.split('/').pop() || '';
        if (!filename.toLowerCase().startsWith('mi_')) {
            const filenameMatch = filename.match(filenameRegex);
            if (filenameMatch) {
                heroIds.add(filenameMatch[1]);
            }
        }
    });

    const heroNames = new Set<string>();
    heroIds.forEach(id => {
        const char = characterData.find((c: any) => c.id === id);
        if (char) {
            heroNames.add(char.name);
        }
    });

    return Array.from(heroNames);
}
