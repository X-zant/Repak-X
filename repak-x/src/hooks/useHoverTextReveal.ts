import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * Slides truncated text sideways to reveal the rest after a sustained hover.
 * Attach `containerRef` to the clipping element and `innerRef` to the text
 * inside it; `revealStyle` (sets `--reveal-distance` / `--reveal-duration`) is
 * only defined while sliding.
 */
export function useHoverTextReveal<C extends HTMLElement = HTMLElement, I extends HTMLElement = HTMLElement>(
  enabled = true,
  delayMs = 500
) {
  const containerRef = useRef<C | null>(null)
  const innerRef = useRef<I | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [revealStyle, setRevealStyle] = useState<CSSProperties | undefined>(undefined)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onMouseEnter = useCallback(() => {
    if (!enabled) return
    clearTimer()
    timerRef.current = setTimeout(() => {
      const container = containerRef.current
      const inner = innerRef.current
      if (!container || !inner) return

      const overflow = inner.offsetWidth - container.clientWidth
      if (overflow > 2) {
        setRevealStyle({
          '--reveal-distance': `-${overflow}px`,
          '--reveal-duration': `${Math.min(6, Math.max(1.2, overflow / 60))}s`
        } as CSSProperties)
      }
    }, delayMs)
  }, [enabled, delayMs, clearTimer])

  const reset = useCallback(() => {
    clearTimer()
    setRevealStyle(undefined)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  return { containerRef, innerRef, revealStyle, onMouseEnter, onMouseLeave: reset, reset }
}
