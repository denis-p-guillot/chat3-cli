type DiagnoseToolboxWidgetProps = {
  dragOver: boolean
  diagnoseBusy: boolean
  diagnoseErr: string | null
  diagnoseContext: string
  diagnoseSshConnections: string[]
  sshDragType: string
  onDragOverState: (v: boolean) => void
  onDropSshConnection: (name: string) => void
  onRemoveDiagnoseSshConnection: (name: string) => void
  onDiagnoseContextChange: (value: string) => void
  onRunDiagnose: () => void
}

export function DiagnoseToolboxWidget({
  dragOver,
  diagnoseBusy,
  diagnoseErr,
  diagnoseContext,
  diagnoseSshConnections,
  sshDragType,
  onDragOverState,
  onDropSshConnection,
  onRemoveDiagnoseSshConnection,
  onDiagnoseContextChange,
  onRunDiagnose,
}: DiagnoseToolboxWidgetProps) {
  return (
    <div className="sidebar-section sidebar-widget">
      <h2>Diagnose Error</h2>
      <div
        className={`toolbox-item ${dragOver ? 'toolbox-drop' : ''}`}
        onDragEnter={(e) => {
          const hasSsh = Array.from(e.dataTransfer.types).includes(sshDragType)
          if (!hasSsh) return
          e.preventDefault()
          onDragOverState(true)
        }}
        onDragOver={(e) => {
          const hasSsh = Array.from(e.dataTransfer.types).includes(sshDragType)
          if (!hasSsh) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          onDragOverState(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          onDragOverState(false)
          const name = e.dataTransfer.getData(sshDragType)
          if (name) onDropSshConnection(name)
        }}
      >
        <p className="muted toolbox-help">
          Generates <code>issue_analysis.html</code> in the active workspace and links it to your next prompt.
        </p>
        <p className="muted toolbox-help">
          Drag SSH connections from the Connectivity widget here to grant diagnosis SSH scope.
        </p>
        {diagnoseSshConnections.length > 0 && (
          <ul className="toolbox-ssh-list">
            {diagnoseSshConnections.map((name) => (
              <li key={name}>
                <span>{name}</span>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => onRemoveDiagnoseSshConnection(name)}
                  aria-label={`Remove SSH connection ${name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          className="toolbox-textarea"
          placeholder="Paste logs, traceback, or incident context..."
          value={diagnoseContext}
          onChange={(e) => onDiagnoseContextChange(e.target.value)}
          rows={5}
        />
        {diagnoseErr && <p className="warn">{diagnoseErr}</p>}
        <button type="button" className="btn secondary" onClick={onRunDiagnose} disabled={diagnoseBusy}>
          {diagnoseBusy ? 'Generating…' : 'Run Diagnose Error'}
        </button>
      </div>
    </div>
  )
}
