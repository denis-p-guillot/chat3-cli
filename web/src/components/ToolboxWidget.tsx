import type { ProposalFormState } from '../lib/proposalPrompt'

type ToolboxWidgetProps = {
  open: boolean
  dragOver: boolean
  chatBusy: boolean
  diagnoseBusy: boolean
  diagnoseErr: string | null
  diagnoseContext: string
  diagnoseSshConnections: string[]
  proposalBusy: boolean
  proposalErr: string | null
  proposalForm: ProposalFormState
  sshDragType: string
  onDragOverState: (v: boolean) => void
  onDropSshConnection: (name: string) => void
  onRemoveDiagnoseSshConnection: (name: string) => void
  onDiagnoseContextChange: (value: string) => void
  onRunDiagnose: () => void
  onProposalFormChange: (patch: Partial<ProposalFormState>) => void
  onRunProposal: () => void
}

export function ToolboxWidget({
  open,
  dragOver,
  chatBusy,
  diagnoseBusy,
  diagnoseErr,
  diagnoseContext,
  diagnoseSshConnections,
  proposalBusy,
  proposalErr,
  proposalForm,
  sshDragType,
  onDragOverState,
  onDropSshConnection,
  onRemoveDiagnoseSshConnection,
  onDiagnoseContextChange,
  onRunDiagnose,
  onProposalFormChange,
  onRunProposal,
}: ToolboxWidgetProps) {
  if (!open) return null
  return (
    <div className="sidebar-section sidebar-widget">
      <h2>Toolbox</h2>
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
        <h3>Diagnose Error</h3>
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

      <div className="toolbox-item toolbox-item-proposal">
        <h3>Proposal</h3>
        <p className="muted toolbox-help">
          Draft a commercial proposal for a <strong>dedicated Odoo</strong> environment on{' '}
          <a href="https://purple-cloud.ai" target="_blank" rel="noreferrer">
            PurpleCloud
          </a>{' '}
          (backups, monitoring, Git deploys, multi-environment hosting). Required fields below must be filled
          before running.
        </p>
        <div className="toolbox-form">
          <label>
            Odoo version <span className="req">*</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 17, 18, 19"
              value={proposalForm.odooVersion}
              onChange={(e) => onProposalFormChange({ odooVersion: e.target.value })}
            />
          </label>
          <label>
            Edition <span className="req">*</span>
            <select
              value={proposalForm.edition}
              onChange={(e) =>
                onProposalFormChange({
                  edition: e.target.value as ProposalFormState['edition'],
                })
              }
            >
              <option value="">Select…</option>
              <option value="enterprise">Enterprise</option>
              <option value="community">Community</option>
            </select>
          </label>
          <label>
            Number of ERP users <span className="req">*</span>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="Named / billable Odoo users"
              value={proposalForm.erpUserCount}
              onChange={(e) => onProposalFormChange({ erpUserCount: e.target.value })}
            />
          </label>
          <label>
            Expected daily website visitors <span className="optional">(optional)</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="e-commerce / public site; leave empty if N/A"
              value={proposalForm.dailyWebsiteVisitors}
              onChange={(e) => onProposalFormChange({ dailyWebsiteVisitors: e.target.value })}
            />
          </label>
        </div>
        <label className="toolbox-notes-label">
          Additional context <span className="optional">(optional)</span>
          <textarea
            className="toolbox-textarea"
            placeholder="Customer name, regions, key modules, integrations, timelines…"
            value={proposalForm.extraNotes}
            onChange={(e) => onProposalFormChange({ extraNotes: e.target.value })}
            rows={4}
          />
        </label>
        {proposalErr && <p className="warn">{proposalErr}</p>}
        <button
          type="button"
          className="btn secondary"
          onClick={onRunProposal}
          disabled={proposalBusy || chatBusy || diagnoseBusy}
        >
          {proposalBusy ? 'Sending…' : 'Run Proposal'}
        </button>
      </div>
    </div>
  )
}
