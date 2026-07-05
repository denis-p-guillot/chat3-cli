import { useMemo, useState } from 'react'
import type { SshConnection, WorkspaceSummary } from '../lib/connectivity'

function IconEdit({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20h4l10-10a2.2 2.2 0 10-3.1-3.1L4.9 16.9 4 20z" />
    </svg>
  )
}

export type SshFormState = {
  name: string
  host: string
  port: number
  username: string
  auth_mode: 'private_key' | 'password' | 'private_key_password'
  private_key: string
  password: string
}

type ConnectivityWidgetProps = {
  busy: boolean
  error: string | null
  editorOpen: boolean
  editingName: string | null
  form: SshFormState
  connections: SshConnection[]
  workspaces: WorkspaceSummary[]
  activeWorkspaceId: number
  sshDragType: string
  onStartNew: () => void
  onCloseEditor: () => void
  onFormChange: (next: SshFormState) => void
  onSubmit: () => void
  onEdit: (c: SshConnection) => void
  onTest: (id: number) => void
  onDelete: (id: number, global?: boolean) => void
  onShareWorkspaces: (id: number, workspaceIds: number[]) => Promise<void>
}

export function ConnectivityWidget({
  busy,
  error,
  editorOpen,
  editingName,
  form,
  connections,
  workspaces,
  activeWorkspaceId,
  sshDragType,
  onStartNew,
  onCloseEditor,
  onFormChange,
  onSubmit,
  onEdit,
  onTest,
  onDelete,
  onShareWorkspaces,
}: ConnectivityWidgetProps) {
  const [shareTarget, setShareTarget] = useState<SshConnection | null>(null)
  const [shareSelection, setShareSelection] = useState<number[]>([])
  const [shareBusy, setShareBusy] = useState(false)
  const [shareErr, setShareErr] = useState<string | null>(null)

  const workspaceNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const ws of workspaces) map.set(ws.id, ws.name)
    return map
  }, [workspaces])

  const openShare = (connection: SshConnection) => {
    setShareTarget(connection)
    setShareSelection([...connection.shared_workspace_ids])
    setShareErr(null)
  }

  const closeShare = () => {
    if (shareBusy) return
    setShareTarget(null)
    setShareSelection([])
    setShareErr(null)
  }

  const toggleShareWorkspace = (workspaceId: number) => {
    setShareSelection((prev) => {
      if (prev.includes(workspaceId)) {
        if (prev.length <= 1) return prev
        return prev.filter((id) => id !== workspaceId)
      }
      return [...prev, workspaceId].sort((a, b) => a - b)
    })
  }

  const submitShare = async () => {
    if (!shareTarget) return
    setShareBusy(true)
    setShareErr(null)
    try {
      await onShareWorkspaces(shareTarget.id, shareSelection)
      closeShare()
    } catch (err) {
      setShareErr(err instanceof Error ? err.message : String(err))
    } finally {
      setShareBusy(false)
    }
  }

  return (
    <div className="sidebar-section sidebar-widget">
      <h2>
        <span>Connectivity (SSH)</span>
        <span className="ssh-head-actions">
          <button type="button" className="workspace-refresh-btn" onClick={onStartNew} disabled={busy}>
            New
          </button>
        </span>
      </h2>
      {error && <p className="warn">{error}</p>}
      {editorOpen && (
        <form
          className="ssh-form"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
        >
          <input
            value={form.name}
            onChange={(e) => onFormChange({ ...form, name: e.target.value })}
            placeholder="Connection name (e.g. prod)"
            required
            maxLength={128}
          />
          <input
            value={form.host}
            onChange={(e) => onFormChange({ ...form, host: e.target.value })}
            placeholder="Host (e.g. server.example.com)"
            required
            maxLength={255}
          />
          <div className="ssh-inline">
            <input
              value={form.username}
              onChange={(e) => onFormChange({ ...form, username: e.target.value })}
              placeholder="Username"
              required
              maxLength={128}
            />
            <input
              type="number"
              value={form.port}
              onChange={(e) => {
                const parsed = Number(e.target.value)
                onFormChange({ ...form, port: Number.isFinite(parsed) && parsed > 0 ? parsed : 22 })
              }}
              min={1}
              max={65535}
              placeholder="Port"
            />
          </div>
          <select
            value={form.auth_mode}
            onChange={(e) =>
              onFormChange({
                ...form,
                auth_mode: e.target.value as 'private_key' | 'password' | 'private_key_password',
              })
            }
          >
            <option value="private_key">Private key</option>
            <option value="password">Password</option>
            <option value="private_key_password">Private key + password</option>
          </select>
          {form.auth_mode !== 'password' && (
            <textarea
              value={form.private_key}
              onChange={(e) => onFormChange({ ...form, private_key: e.target.value })}
              placeholder="Private key (PEM)"
              rows={4}
              required
            />
          )}
          {form.auth_mode !== 'private_key' && (
            <input
              type="password"
              value={form.password}
              onChange={(e) => onFormChange({ ...form, password: e.target.value })}
              placeholder="Password"
              required
            />
          )}
          <p className="muted ssh-editor-hint">
            {editingName
              ? `Editing "${editingName}". Updates apply to every workspace that shares this profile.`
              : 'Create a new SSH profile in this workspace. You can share it with other workspaces later.'}
          </p>
          <div className="ssh-editor-actions">
            <button type="submit" className="btn secondary" disabled={busy}>
              {editingName ? 'Update connection' : 'Save connection'}
            </button>
            <button type="button" className="workspace-refresh-btn" onClick={onCloseEditor}>
              Close
            </button>
          </div>
        </form>
      )}
      {connections.length > 0 && (
        <div className="ssh-buttons-list">
          {connections.map((c) => (
            <div key={c.id} className="ssh-button-row">
              <button
                type="button"
                className="ssh-conn-btn"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(sshDragType, c.name)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                title="Drag to Diagnose Error widget."
              >
                <strong>{c.name}</strong>
                <span>
                  {c.username}@{c.host}:{c.port}
                </span>
                {c.is_shared && <span className="ssh-share-badge">Shared · {c.shared_workspace_ids.length} workspaces</span>}
              </button>
              <div className="ssh-actions">
                <button
                  type="button"
                  className="ssh-icon-btn"
                  onClick={() => onEdit(c)}
                  aria-label={`Edit SSH connection ${c.name}`}
                  title="Edit connection"
                  disabled={busy}
                >
                  <IconEdit className="ssh-icon-svg" />
                </button>
                <button
                  type="button"
                  className="workspace-refresh-btn"
                  onClick={() => openShare(c)}
                  disabled={busy || workspaces.length <= 1}
                  title="Share with other workspaces"
                >
                  Share
                </button>
                {editorOpen && editingName === c.name && (
                  <>
                    <button type="button" className="workspace-refresh-btn" onClick={() => onTest(c.id)} disabled={busy}>
                      Test
                    </button>
                    <button
                      type="button"
                      className="workspace-refresh-btn"
                      onClick={() => onDelete(c.id, false)}
                      disabled={busy}
                      title={c.is_shared ? 'Remove from this workspace only' : 'Delete connection'}
                    >
                      {c.is_shared ? 'Remove' : 'Delete'}
                    </button>
                    {c.is_shared && (
                      <button
                        type="button"
                        className="workspace-refresh-btn"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete "${c.name}" from all workspaces? This cannot be undone.`,
                            )
                          ) {
                            onDelete(c.id, true)
                          }
                        }}
                        disabled={busy}
                      >
                        Delete all
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {shareTarget && (
        <div className="ssh-share-panel">
          <div className="ssh-share-head">
            <strong>Share “{shareTarget.name}”</strong>
            <button type="button" className="workspace-refresh-btn" onClick={closeShare} disabled={shareBusy}>
              Close
            </button>
          </div>
          <p className="muted ssh-editor-hint">
            Select the workspaces that may use this SSH profile. At least one workspace must stay linked.
          </p>
          <div className="ssh-share-list">
            {workspaces.map((ws) => {
              const checked = shareSelection.includes(ws.id)
              const isActive = ws.id === activeWorkspaceId
              return (
                <label key={ws.id} className="ssh-share-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleShareWorkspace(ws.id)}
                    disabled={shareBusy || (checked && shareSelection.length <= 1)}
                  />
                  <span>
                    {ws.name}
                    {isActive ? ' (current)' : ''}
                  </span>
                </label>
              )
            })}
          </div>
          {shareTarget.shared_workspace_ids.length > 0 && (
            <p className="muted ssh-editor-hint">
              Currently linked:{' '}
              {shareTarget.shared_workspace_ids
                .map((id) => workspaceNameById.get(id) ?? `Workspace ${id}`)
                .join(', ')}
            </p>
          )}
          {shareErr && <p className="warn">{shareErr}</p>}
          <div className="ssh-editor-actions">
            <button type="button" className="btn secondary" onClick={() => void submitShare()} disabled={shareBusy}>
              {shareBusy ? 'Saving…' : 'Save sharing'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
