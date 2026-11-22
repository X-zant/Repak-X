import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MdAdd, MdDashboardCustomize, MdSave, MdUndo } from 'react-icons/md'
import CustomDropdown from './CustomDropdown'
import InputPromptModal from './InputPromptModal'
import { useAlert } from './AlertHandler'
import './ProfilePicker.css'

type ProfileInfo = { id: string; name: string; saved_at: number }

type ProfileStatus = {
  profiles: ProfileInfo[]
  active: string | null
  dirty: boolean
  unknown: number
  pending_switch: { profile_name: string; done: number; total: number } | null
}

type ProfilePickerProps = {
  /** Any change (a rescan) refreshes the dirty state */
  mods: unknown
  /** Reloads the mod list after a switch */
  onSwitched: () => Promise<unknown>
  /** Project Galacta's pak when Galacta Mode applies: then only mods the game has loaded block a switch */
  galactaModPath: string | null
}

/**
 * Mod list profiles: named, explicitly saved sets of which mods are enabled
 * (docs/MOD_DB_PLAN.md §6). Toggling mods marks the active profile unsaved;
 * it never changes the profile until Save.
 */
const ProfilePicker = ({ mods, onSwitched, galactaModPath }: ProfilePickerProps) => {
  const alert = useAlert()
  const [status, setStatus] = useState<ProfileStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState(false)
  const [deleting, setDeleting] = useState<ProfileInfo | null>(null)
  /** Switch target waiting on Save / Discard for unsaved changes */
  const [leaving, setLeaving] = useState<string | null>(null)
  const [interruptedDismissed, setInterruptedDismissed] = useState(false)
  /** Switch target waiting on what to do with installed mods it has never seen */
  const [unknownPrompt, setUnknownPrompt] = useState<{ id: string; files: string[] } | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<ProfileStatus>('get_profiles'))
    } catch (e) {
      console.warn('get_profiles failed', e)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [mods, refresh])

  const nameOf = (id: string | null) =>
    status?.profiles.find(p => p.id === id)?.name ?? 'profile'

  const switchTo = async (id: string) => {
    setBusy(true)
    try {
      const changed = await invoke<number>('switch_profile', { id, galactaModPath })
      await onSwitched()
      alert.success(
        `Switched to ${nameOf(id)}`,
        changed === 0 ? 'Mods already matched this profile' : `${changed} mod(s) enabled or disabled`
      )
    } catch (e) {
      alert.error('Profile switch failed', String(e))
      setInterruptedDismissed(false)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const save = async (id: string) => {
    try {
      await invoke('save_profile', { id })
      await refresh()
      return true
    } catch (e) {
      alert.error('Saving profile failed', String(e))
      return false
    }
  }

  /** Switches to another profile, first asking about mods it has never seen */
  const switchToOther = async (id: string) => {
    try {
      const files = await invoke<string[]>('get_profile_unknown_mods', { id })
      if (files.length > 0) {
        setUnknownPrompt({ id, files })
        return
      }
    } catch (e) {
      console.warn('get_profile_unknown_mods failed', e)
    }
    switchTo(id)
  }

  const handleUnknownChoice = async (choice: string) => {
    const target = unknownPrompt
    setUnknownPrompt(null)
    if (!target) return
    const enabled = choice === 'enable' ? true : choice === 'disable' ? false : null
    try {
      await invoke('adopt_profile_unknown_mods', { id: target.id, enabled })
    } catch (e) {
      alert.error('Updating profile failed', String(e))
      return
    }
    switchTo(target.id)
  }

  const handleSelect = (id: string) => {
    if (!status || id === status.active) return
    if (status.active && status.dirty) {
      setLeaving(id)
    } else {
      switchToOther(id)
    }
  }

  const handleLeaveChoice = async (choice: string) => {
    const target = leaving
    setLeaving(null)
    if (!target || !status?.active) return
    if (choice === 'save' && !(await save(status.active))) return
    switchToOther(target)
  }

  const handleCreate = async (name: string) => {
    setNaming(false)
    try {
      await invoke('create_profile', { name })
      await refresh()
    } catch (e) {
      alert.error('Creating profile failed', String(e))
    }
  }

  const handleRename = async (id: string, name: string) => {
    try {
      await invoke('rename_profile', { id, name })
      await refresh()
    } catch (e) {
      alert.error('Renaming profile failed', String(e))
    }
  }

  const handleDelete = async () => {
    const target = deleting
    setDeleting(null)
    if (!target) return
    try {
      await invoke('delete_profile', { id: target.id })
      await refresh()
    } catch (e) {
      alert.error('Deleting profile failed', String(e))
    }
  }

  const finishInterrupted = async (choice: string) => {
    setInterruptedDismissed(true)
    setBusy(true)
    try {
      await invoke('finish_interrupted_switch', { rollback: choice === 'rollback', galactaModPath })
      await onSwitched()
    } catch (e) {
      alert.error('Profile switch failed', String(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  if (!status) return null
  const active = status.active
  const pending = status.pending_switch
  const unsaved = !!active && status.dirty
  const unsavedTitle = status.unknown > 0
    ? `${status.unknown} installed mod(s) are not in this profile yet: switching profiles leaves them as they are. Save to add them.`
    : 'Mods were enabled or disabled since this profile was saved'

  return (
    <div className="profile-picker">
      <CustomDropdown
        className="profile-picker-dropdown"
        icon={<MdDashboardCustomize style={{ fontSize: 'var(--fs-lg)', color: 'var(--accent-primary)' }} />}
        placeholder="No profile"
        value={active ?? undefined}
        disabled={busy}
        options={status.profiles.map(p => ({ value: p.id, label: p.name, showDelete: true }))}
        onChange={handleSelect}
        onAddNew={() => setNaming(true)}
        addNewLabel={<><MdAdd /> New profile</>}
        onDeleteOption={id => setDeleting(status.profiles.find(p => p.id === id) ?? null)}
        valueSuffix={unsaved && <span className="profile-picker-unsaved" title={unsavedTitle}>*</span>}
        actions={unsaved ? [
          { label: 'Save', icon: <MdSave />, onClick: () => save(active!), title: 'Save the current enabled/disabled state into this profile' },
          { label: 'Revert', icon: <MdUndo />, onClick: () => switchTo(active!), title: 'Enable/disable mods back to how this profile was saved' },
        ] : []}
        onRenameOption={handleRename}
      />

      <InputPromptModal
        isOpen={naming}
        title="New Profile"
        description="Saves which mods are enabled right now. Priority, folders and tags are not part of a profile."
        placeholder="Profile name..."
        confirmText="Create"
        icon={<MdDashboardCustomize />}
        onConfirm={handleCreate}
        onCancel={() => setNaming(false)}
      />

      <InputPromptModal
        isOpen={!!deleting}
        mode="confirm"
        title="Delete Profile"
        description={deleting ? `Delete "${deleting.name}"? Your mods stay as they are.` : ''}
        confirmText="Delete"
        icon={<MdDashboardCustomize />}
        accentColor="#ef4444"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      <InputPromptModal
        isOpen={!!leaving}
        mode="choice"
        title="Unsaved changes"
        description={`"${nameOf(active)}" has unsaved changes. Save them before switching?`}
        icon={<MdDashboardCustomize />}
        options={[
          { value: 'save', label: 'Save and switch' },
          { value: 'discard', label: 'Switch without saving' },
        ]}
        onConfirm={handleLeaveChoice}
        onCancel={() => setLeaving(null)}
      />

      <InputPromptModal
        isOpen={!!unknownPrompt}
        mode="choice"
        title="Mods not in this profile"
        description={unknownPrompt
          ? `${unknownPrompt.files.length} installed mod(s) were added after "${nameOf(unknownPrompt.id)}" was saved. Your answer is saved into the profile.`
          : ''}
        icon={<MdDashboardCustomize />}
        options={[
          { value: 'keep', label: 'Keep them as they are' },
          { value: 'enable', label: 'Enable them' },
          { value: 'disable', label: 'Disable them' },
        ]}
        onConfirm={handleUnknownChoice}
        onCancel={() => setUnknownPrompt(null)}
      >
        <ul className="profile-unknown-list">
          {unknownPrompt?.files.map(file => {
            const enabled = /\.pak$/i.test(file)
            return (
              <li key={file}>
                <span className="profile-unknown-name" title={file}>{file.replace(/\.(pak|bak_repak|pak_disabled)$/i, '').replace(/(_\d+_P)+$/i, '')}</span>
                <span className={`profile-unknown-state ${enabled ? 'on' : ''}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
              </li>
            )
          })}
        </ul>
      </InputPromptModal>

      <InputPromptModal
        isOpen={!!pending && !interruptedDismissed && !busy}
        mode="choice"
        title="Profile switch interrupted"
        description={pending ? `Switching to "${pending.profile_name}" stopped after ${pending.done} of ${pending.total} mod(s). Your mods match neither profile right now.` : ''}
        icon={<MdDashboardCustomize />}
        options={[
          { value: 'resume', label: 'Finish the switch' },
          { value: 'rollback', label: 'Undo it' },
        ]}
        onConfirm={finishInterrupted}
        onCancel={() => setInterruptedDismissed(true)}
      />
    </div>
  )
}

export default ProfilePicker
