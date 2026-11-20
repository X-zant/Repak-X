import { useRef } from 'react'
import type React from 'react'

// Mouse-event drag instead of HTML5 drag-and-drop: Tauri's native file drop
// (dragDropEnabled, needed for installing mods from Explorer) swallows HTML5
// drag events inside WebView2, so draggable/onDrop never fire there.
// Drop targets are any element with `data-folder-id` (the folder tree nodes).

const DRAG_THRESHOLD = 6
// Controls that keep their own mouse behaviour; dragging from them would fight it.
const NO_DRAG = 'input, textarea, .mod-checkbox-wrapper, .mod-switch-wrapper, .hold-delete, .tag-remove, .number-input-container'

export function useModDragToFolder(
    onDrop: (modPath: string, folderId: string) => void,
    countFor: (modPath: string) => number
) {
    const onDropRef = useRef(onDrop)
    const countRef = useRef(countFor)
    onDropRef.current = onDrop
    countRef.current = countFor

    const onMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return
        const target = e.target as HTMLElement
        if (target.closest(NO_DRAG)) return
        const card = target.closest<HTMLElement>('.mod-card[data-mod-path]')
        const modPath = card?.dataset.modPath
        if (!card || !modPath) return

        const startX = e.clientX
        const startY = e.clientY
        let ghost: HTMLDivElement | null = null
        let hover: HTMLElement | null = null

        const setHover = (el: HTMLElement | null) => {
            if (el === hover) return
            hover?.classList.remove('drop-target')
            el?.classList.add('drop-target')
            hover = el
        }

        const move = (ev: MouseEvent) => {
            if (!ghost) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
                const count = countRef.current(modPath)
                const name = card.querySelector('.mod-name-inner')?.textContent || 'mod'
                ghost = document.createElement('div')
                ghost.className = 'mod-drag-ghost'
                ghost.textContent = count > 1 ? `${count} mods` : name
                document.body.appendChild(ghost)
                document.body.classList.add('mod-dragging')
                card.classList.add('drag-source')
                window.getSelection()?.removeAllRanges()
            }
            ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`
            const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
            setHover(el?.closest<HTMLElement>('[data-folder-id]') ?? null)
        }

        const end = (drop: boolean) => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            window.removeEventListener('keydown', key, true)
            if (!ghost) return
            ghost.remove()
            document.body.classList.remove('mod-dragging')
            card.classList.remove('drag-source')
            const folderId = hover?.dataset.folderId
            setHover(null)
            // The mouseup would otherwise land as a click (select / toggle) on the card.
            const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault() }
            window.addEventListener('click', swallow, true)
            setTimeout(() => window.removeEventListener('click', swallow, true), 0)
            if (drop && folderId) onDropRef.current(modPath, folderId)
        }
        const up = () => end(true)
        const key = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') { ev.stopPropagation(); end(false) }
        }

        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        window.addEventListener('keydown', key, true)
    }

    return {
        onMouseDown,
        // Hero icons are <img>, which start a native drag that Tauri then captures.
        onDragStart: (e: React.DragEvent) => e.preventDefault(),
    }
}
