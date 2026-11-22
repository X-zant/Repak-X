// Monochrome accent follows the theme: white on dark, black on light.
export const monoAccent = (theme: string) => (theme === 'light' ? '#000000' : '#ffffff')
export const isMonoAccent = (hex: string) => hex === '#ffffff' || hex === '#000000'

/** Maps the saved 'monochrome' name (or a stale mono hex) to the hex for the current theme. */
export const resolveMonoAccent = (accent: string, theme: string) =>
  accent === 'monochrome' || isMonoAccent(accent) ? monoAccent(theme) : accent

// Greys only, no pure white/black peaks so the gradient stays visible.
export const MONO_AURORA_PALETTES: Record<string, string[]> = {
  '#ffffff': ['#e5e5e5', '#8a8a8a', '#cfcfcf', '#a3a3a3'],
  '#000000': ['#2a2a2a', '#7a7a7a', '#454545', '#5c5c5c'],
}

/** Sets --on-accent so text/icons on accent fills stay readable on a white accent. */
export const applyOnAccent = (hex: string) =>
  document.documentElement.style.setProperty('--on-accent', hex === '#ffffff' ? '#000000' : '#ffffff')
