import type { SshConnection } from '../lib/connectivity'

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
  open: boolean
  busy: boolean
  error: string | null
  editorOpen: boolean
  editingName: string | null
  form: SshFormState
  connections: SshConnection[]
  sshDragType: string
  onToggleOpen: () => void
  onStartNew: () => void
  onCloseEditor: () => void
  onFormChange: (next: SshFormState) => void
  onSubmit: () => void
  onEdit: (c: SshConnection) => void
  onTest: (id: number) => void
  onDelete: (id: number) => void
}

export function ConnectivityWidget({
  open,
  busy,
  error,
  editorOpen,
  editingName,
  form,
  connections,
  sshDragType,
  onToggleOpen,
  onStartNew,
  onCloseEditor,
  onFormChange,
  onSubmit,
  onEdit,
  onTest,
  onDelete,
}: ConnectivityWidgetProps) {
  return (
    <div className="sidebar-section sidebar-widget">
      <h2>
        <span>Connectivity (SSH)</span>
        <span className="ssh-head-actions">
          <button type="button" className="workspace-refresh-btn" onClick={onStartNew} disabled={busy}>
            New
          </button>
          <button
            type="button"
            className="workspace-refresh-btn"
            onClick={onToggleOpen}
            aria-label={open ? 'Collapse connectivity section' : 'Expand connectivity section'}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </span>
      </h2>
      {error && <p className="warn">{error}</p>}
      {open && (
        <>
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
                  ? `Editing "${editingName}". Provide credentials to update this connection.`
                  : 'Create a new SSH connection profile.'}
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
                    title="Drag to Toolbox > Diagnose Error."
                  >
                    <strong>{c.name}</strong>
                    <span>
                      {c.username}@{c.host}:{c.port}
                    </span>
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
                    {editorOpen && editingName === c.name && (
                      <>
                        <button type="button" className="workspace-refresh-btn" onClick={() => onTest(c.id)} disabled={busy}>
                          Test
                        </button>
                        <button type="button" className="workspace-refresh-btn" onClick={() => onDelete(c.id)} disabled={busy}>
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
