/** UI scale for 'Auto': by the screen's width after Windows display scaling, so a
 * small laptop screen gets a bit more room and a large monitor a bit more size. */
export function autoUiScale(): number {
  const w = window.screen.width
  return w < 1700 ? 90 : w < 2300 ? 100 : 110
}
