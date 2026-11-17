import { useCallback, useRef } from 'react'
import type React from 'react'
import { useStableCallback } from './useStableCallback'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Props that turn a modal's panel into a real dialog: role/aria-modal/label,
 * focus moved in on open (unless a child already took it via autoFocus),
 * Tab kept inside, Escape closes, and focus handed back on close.
 *
 * Uses a callback ref so it works for panels that mount later than the
 * component (AnimatePresence / isOpen patterns).
 */
export function useDialog(onClose: () => void, label: string) {
  const close = useStableCallback(onClose)
  const prevFocus = useRef<HTMLElement | null>(null)

  const ref = useCallback((node: HTMLElement | null) => {
    if (node) {
      prevFocus.current = document.activeElement as HTMLElement | null
      if (!node.contains(document.activeElement)) node.focus()
    } else {
      const active = document.activeElement
      if (!active || active === document.body) prevFocus.current?.focus?.()
      prevFocus.current = null
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'Tab') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => el.offsetParent !== null)
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === e.currentTarget)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return {
    ref,
    role: 'dialog' as const,
    'aria-modal': true,
    'aria-label': label,
    tabIndex: -1,
    onKeyDown,
  }
}
