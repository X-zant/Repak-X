// VFX Updater - Color Parameter Filtering

export interface FilterDictionary {
  includes: string[];
  excludes: string[];
}

export const DEFAULT_FILTER: FilterDictionary = {
  includes: ["color", "emissive", "glow", "tint", "Enemy", "Emiss", "Diff"],
  excludes: ["Offset", "uv", "ColorMaskChannel", "MaskColor_Enemy"],
};

/** True when `paramName` hits an exclude keyword (and must never be ported). */
export function paramIsExcluded(
  paramName: string,
  filterDictionary: FilterDictionary = DEFAULT_FILTER
): boolean {
  const lowerName = paramName.toLowerCase();
  return filterDictionary.excludes.some((keyword) => lowerName.includes(keyword.toLowerCase()));
}

export function paramMatchesFilter(
  paramName: string,
  filterDictionary: FilterDictionary = DEFAULT_FILTER
): boolean {
  const lowerName = paramName.toLowerCase();

  for (const keyword of filterDictionary.excludes) {
    if (lowerName.includes(keyword.toLowerCase())) {
      console.debug("[VFX] Filter excluded:", paramName, "matched exclude:", keyword);
      return false;
    }
  }

  for (const keyword of filterDictionary.includes) {
    if (lowerName.includes(keyword.toLowerCase())) {
      console.debug("[VFX] Filter included:", paramName, "matched include:", keyword);
      return true;
    }
  }

  console.debug("[VFX] Filter rejected (no include match):", paramName);
  return false;
}
