import type { Me } from '../lib/auth'

type AccountWidgetProps = {
  me: Me
  workspaceBusy: boolean
  busy: boolean
  historyHydrated: boolean
  onAddWorkspace: () => void
  onDeleteWorkspace: () => void
}

export function AccountWidget({
  me,
  workspaceBusy,
  busy,
  historyHydrated,
  onAddWorkspace,
  onDeleteWorkspace,
}: AccountWidgetProps) {
  return (
    <div className="sidebar-section">
      <div className="workspace-actions-row">
        <button
          type="button"
          className="btn secondary workspace-new-btn"
          onClick={onAddWorkspace}
          disabled={workspaceBusy || busy || !historyHydrated}
        >
          New workspace
        </button>
        <button
          type="button"
          className="btn secondary workspace-delete-btn"
          onClick={onDeleteWorkspace}
          disabled={workspaceBusy || busy || !historyHydrated}
        >
          Delete workspace
        </button>
      </div>
      {!me.has_openai_key && <p className="warn">Add your OpenAI API key in Settings before sending messages.</p>}
    </div>
  )
}
