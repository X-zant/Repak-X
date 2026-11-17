import React, { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { IoMdWarning } from "react-icons/io"
import { RiDeleteBin2Fill } from 'react-icons/ri'
import {
    Close,
    WarningAmberRounded,
    InsertDriveFileOutlined,
    CheckCircleOutline
} from '@mui/icons-material'
import NumberInput from './ui/NumberInput'
import Switch from './ui/Switch'
import './ClashPanel.css'
import { useDialog } from '../hooks/useDialog'
import { useHoverTextReveal } from '../hooks/useHoverTextReveal'

type ClashRecord = {
    file_path: string
    mod_paths: string[]
}

type ModRecord = {
    path: string
    priority?: number
    enabled?: boolean
}

type ClashPanelProps = {
    clashes: ClashRecord[]
    mods?: ModRecord[]
    onSetPriority?: (modPath: string, priority: number) => void
    onToggleMod?: (modPath: string) => void
    onClose: () => void
}

const stemOf = (p: string) => p.replace(/\.(pak|bak_repak|pak_disabled)$/i, '')

/** A row's mod name: slides sideways on hover when it is cut off (same hook as the
 *  mods list). The tooltip is the path inside ~mods, not the full disk path. */
const ClashModName = ({ folder, name, tooltip }: { folder?: string; name: string; tooltip: string }) => {
    const reveal = useHoverTextReveal<HTMLSpanElement, HTMLSpanElement>(
        document.documentElement.getAttribute('data-animations') !== 'off'
    )
    return (
        <span
            ref={reveal.containerRef}
            className={`clash-mod-name ${reveal.revealStyle ? 'is-scrolling' : ''}`}
            style={reveal.revealStyle}
            title={tooltip}
            onMouseEnter={reveal.onMouseEnter}
            onMouseLeave={reveal.onMouseLeave}
        >
            <span ref={reveal.innerRef} className="clash-mod-name-inner">
                {folder && <span className="clash-mod-folder">{folder}\</span>}
                {name}
            </span>
        </span>
    )
}

const ClashPanel = ({ clashes, mods = [], onSetPriority, onToggleMod, onClose }: ClashPanelProps) => {
    const dialog = useDialog(onClose, 'Mod conflicts')
    // Duplicates (find_duplicate_mods): the same mod installed more than once, shown
    // as ordinary conflict cards with a Duplicate pill
    const [duplicates, setDuplicates] = useState<string[][]>([])
    useEffect(() => {
        invoke<string[][]>('find_duplicate_mods').then(setDuplicates).catch(console.warn)
    }, [])
    // The mod's name without extension and priority suffix, as the mods list shows it
    const modName = (p: string) =>
        stemOf(p.split(/[\\/]/).pop() || p).replace(/_\d+_P$/i, '').replace(/_P$/i, '')
    // Deleted from this panel: hidden right away (the conflict list is not
    // recomputed while the panel is open). A card left with one mod is resolved.
    const [deletedPaths, setDeletedPaths] = useState<Set<string>>(new Set())
    const [deletingPath, setDeletingPath] = useState<string | null>(null)
    const deleteMod = async (path: string) => {
        setDeletingPath(path)
        try {
            await invoke('delete_mod', { path })
            setDeletedPaths(prev => new Set(prev).add(stemOf(path)))
        } catch (e) {
            console.warn('Delete from conflicts failed:', e)
        } finally {
            setDeletingPath(null)
        }
    }
    const remaining = (paths: string[]) => paths.filter(p => !deletedPaths.has(stemOf(p)))
    // Copies of one mod always clash with each other (same files), so a conflict
    // whose mods all belong to one duplicate group is that duplicate again: shown
    // once, as the Duplicate card. A conflict that also involves another mod stays.
    const duplicateGroupOf = useMemo(() => {
        const m = new Map<string, number>()
        duplicates.forEach((g, i) => g.forEach(p => m.set(stemOf(p), i)))
        return m
    }, [duplicates])
    const isOnlyDuplicates = (paths: string[]) => {
        const groups = new Set(paths.map(p => duplicateGroupOf.get(stemOf(p)) ?? -1))
        return groups.size === 1 && !groups.has(-1)
    }
    const shownClashes = clashes.filter(c => {
        const left = remaining(c.mod_paths)
        return left.length > 1 && !isOnlyDuplicates(left)
    })
    const shownDuplicates = duplicates.filter(g => remaining(g).length > 1)
    const issueCount = shownClashes.length + shownDuplicates.length
    // The list isn't recomputed on toggle, so entries can hold the pre-toggle
    // path; fall back to matching the extension-less path
    const { byPath, byStem } = useMemo(() => {
        const byPath = new Map<string, ModRecord>()
        const byStem = new Map<string, ModRecord>()
        for (const m of mods) {
            byPath.set(m.path, m)
            byStem.set(stemOf(m.path), m)
        }
        return { byPath, byStem }
    }, [mods])

    const baseName = (p: string) => stemOf(p.split(/[/\\]/).pop() || '')
    // Its folder inside ~mods ("Saturn\RoseEclipse"), or ~mods for the root
    const modsFolder = (p: string) => {
        const rel = p.split(/[/\\]~mods[/\\]/i).pop() || p
        const cut = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'))
        return cut > 0 ? rel.slice(0, cut) : '~mods'
    }
    // Rows of one card; a name that appears twice in it shows its folder too
    const renderRows = (paths: string[], badge: string) => {
        const names = paths.map(baseName)
        return paths.map((p, i) => renderModRow(p, badge, names.indexOf(names[i]) !== names.lastIndexOf(names[i])))
    }

    // One mod row, the same in conflict and duplicate cards
    const renderModRow = (path: string, badge: string, showFolder = false) => {
        const mod = byPath.get(path) ?? byStem.get(stemOf(path))
        const currentPath = mod?.path ?? path
        const isDisabled = mod?.enabled === false
        return (
            <div key={stemOf(path)} className={`clash-mod-row ${isDisabled ? 'disabled' : ''}`}>
                <span className="clash-mod-badge">{isDisabled ? 'Disabled' : badge}</span>
                <ClashModName
                    folder={showFolder ? modsFolder(currentPath) : undefined}
                    name={baseName(currentPath)}
                    tooltip={currentPath.split(/[/\\]~mods[/\\]/i).pop() || currentPath}
                />

                {mod && (
                    <div className="clash-priority-wrapper">
                        <NumberInput
                            value={mod.priority || 0}
                            min={0}
                            max={99}
                            onChange={(val) => onSetPriority && onSetPriority(currentPath, val)}
                        />
                    </div>
                )}

                {mod && onToggleMod && (
                    <div className="clash-toggle-wrapper">
                        <Switch
                            title={isDisabled ? 'Enable mod' : 'Disable mod'}
                            size="sm"
                            color="primary"
                            checked={!isDisabled}
                            onChange={() => onToggleMod(currentPath)}
                        />
                    </div>
                )}

                <button
                    className="clash-delete-btn"
                    title="Delete this mod"
                    aria-label={`Delete ${stemOf(currentPath.split(/[/\\]/).pop() || '')}`}
                    disabled={deletingPath === currentPath}
                    onClick={() => deleteMod(currentPath)}
                >
                    <RiDeleteBin2Fill aria-hidden="true" />
                </button>
            </div>
        )
    }

    return (
        <div className="modal-overlay clash-overlay" onClick={onClose}>
            <motion.div
                {...dialog}
                className="clash-panel-content"
                onClick={e => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15 }}
            >
                <div className="clash-header">
                    <h2>
                        <IoMdWarning style={{ color: 'var(--danger)' }} />
                        Mod Conflicts
                        {issueCount > 0 && (
                            <span style={{
                                fontSize: 'var(--fs-sm)',
                                background: 'color-mix(in srgb, var(--danger), transparent 90%)',
                                color: 'var(--danger)',
                                padding: '2px 8px',
                                borderRadius: '12px',
                                border: '1px solid color-mix(in srgb, var(--danger), transparent 80%)'
                            }}>
                                {issueCount}
                            </span>
                        )}
                    </h2>
                    <button aria-label="Close" className="close-icon-btn" onClick={onClose}>
                        <Close fontSize="small" />
                    </button>
                </div>

                <div className="clash-body">
                    {issueCount === 0 ? (
                        <div className="no-clashes">
                            <CheckCircleOutline className="no-clashes-icon" />
                            <p>No conflicts found! Your mods are clean.</p>
                        </div>
                    ) : (
                        <div className="clash-list">
                            {shownClashes.map((clash, i) => (
                                <div key={i} className="clash-card">
                                    <div className="clash-file-path">
                                        <InsertDriveFileOutlined fontSize="small" className="clash-file-icon" />
                                        {clash.file_path.replace(/^\/?Game\//, '')}
                                    </div>

                                    <div className="clash-mods-list">
                                        {renderRows(remaining(clash.mod_paths), 'Conflicting')}
                                    </div>
                                </div>
                            ))}
                            {shownDuplicates.map(group => (
                                <div key={group[0]} className="clash-card">
                                    <div className="clash-file-path">
                                        <InsertDriveFileOutlined fontSize="small" className="clash-file-icon" />
                                        {modName(group[0])}
                                        <span className="clash-duplicate-pill">Duplicate</span>
                                    </div>
                                    <div className="clash-mods-list">
                                        {renderRows(remaining(group), 'Duplicate')}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="clash-footer">
                    <button className="btn-primary" onClick={onClose}>Close</button>
                </div>
            </motion.div>
        </div>
    )
}

export default ClashPanel
