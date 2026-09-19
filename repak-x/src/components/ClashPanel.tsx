import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import { IoMdWarning } from "react-icons/io"
import {
    Close,
    WarningAmberRounded,
    InsertDriveFileOutlined,
    CheckCircleOutline
} from '@mui/icons-material'
import NumberInput from './ui/NumberInput'
import Switch from './ui/Switch'
import './ClashPanel.css'

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

const ClashPanel = ({ clashes, mods = [], onSetPriority, onToggleMod, onClose }: ClashPanelProps) => {
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

    return (
        <div className="modal-overlay clash-overlay" onClick={onClose}>
            <motion.div
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
                        {clashes.length > 0 && (
                            <span style={{
                                fontSize: '0.85rem',
                                background: 'rgba(244, 67, 54, 0.1)',
                                color: 'var(--danger)',
                                padding: '2px 8px',
                                borderRadius: '12px',
                                border: '1px solid rgba(244, 67, 54, 0.2)'
                            }}>
                                {clashes.length}
                            </span>
                        )}
                    </h2>
                    <button className="close-icon-btn" onClick={onClose}>
                        <Close fontSize="small" />
                    </button>
                </div>

                <div className="clash-body">
                    {clashes.length === 0 ? (
                        <div className="no-clashes">
                            <CheckCircleOutline className="no-clashes-icon" />
                            <p>No conflicts found! Your mods are clean.</p>
                        </div>
                    ) : (
                        <div className="clash-list">
                            {clashes.map((clash, i) => (
                                <div key={i} className="clash-card">
                                    <div className="clash-file-path">
                                        <InsertDriveFileOutlined fontSize="small" className="clash-file-icon" />
                                        {clash.file_path.replace(/^\/?Game\//, '')}
                                    </div>

                                    <div className="clash-mods-list">
                                        {clash.mod_paths.map((path: string) => {
                                            const mod = byPath.get(path) ?? byStem.get(stemOf(path))
                                            const currentPath = mod?.path ?? path
                                            const isDisabled = mod?.enabled === false
                                            return (
                                                <div key={stemOf(path)} className={`clash-mod-row ${isDisabled ? 'disabled' : ''}`}>
                                                    <span className="clash-mod-badge">{isDisabled ? 'Disabled' : 'Conflicting'}</span>
                                                    <span className="clash-mod-name" title={currentPath}>
                                                        {stemOf(currentPath.split(/[/\\]/).pop() || '')}
                                                    </span>

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
                                                </div>
                                            )
                                        })}
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
