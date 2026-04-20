import type { Me } from '../lib/auth'
import type { WorkspaceSummary } from '../lib/workspaces'

type AccountWidgetProps = {
  me: Me
  workspaceList: WorkspaceSummary[]
  workspaceBusy: boolean
  busy: boolean
  historyHydrated: boolean
  onSwitchWorkspace: (id: number) => void
  onAddWorkspace: () => void
}

export function AccountWidget({
  me,
  workspaceList,
  workspaceBusy,
  busy,
  historyHydrated,
  onSwitchWorkspace,
  onAddWorkspace,
}: AccountWidgetProps) {
  return (
    <div className="sidebar-section">
      <h2>Account</h2>
      <p className="account-name">{me.display_name}</p>
      <p className="account-user muted" title={me.username}>
        {me.username.includes('@') ? me.username : `@${me.username}`}
      </p>
      <label className="workspace-label">
        <span className="form-label-caption">Workspace</span>
        <select
          className="workspace-select"
          value={me.active_workspace_id}
          onChange={(e) => onSwitchWorkspace(Number(e.target.value))}
          disabled={workspaceBusy || busy || !historyHydrated}
          aria-label="Active workspace"
        >
          {workspaceList.length === 0 ? (
            <option value={me.active_workspace_id}>{me.active_workspace_name || 'Default'}</option>
          ) : (
            workspaceList.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))
          )}
        </select>
      </label>
      <button
        type="button"
        className="btn secondary workspace-new-btn"
        onClick={onAddWorkspace}
        disabled={workspaceBusy || busy || !historyHydrated}
      >
        New workspace
      </button>
      {!me.has_openai_key && <p className="warn">Add your OpenAI API key in Settings before sending messages.</p>}
    </div>
  )
}
