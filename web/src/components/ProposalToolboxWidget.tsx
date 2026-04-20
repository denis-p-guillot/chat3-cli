import type { ProposalFormState } from '../lib/proposalPrompt'

type ProposalToolboxWidgetProps = {
  chatBusy: boolean
  diagnoseBusy: boolean
  proposalBusy: boolean
  proposalErr: string | null
  proposalForm: ProposalFormState
  onProposalFormChange: (patch: Partial<ProposalFormState>) => void
  onRunProposal: () => void
}

export function ProposalToolboxWidget({
  chatBusy,
  diagnoseBusy,
  proposalBusy,
  proposalErr,
  proposalForm,
  onProposalFormChange,
  onRunProposal,
}: ProposalToolboxWidgetProps) {
  return (
    <div className="sidebar-section sidebar-widget">
      <h2>Proposal</h2>
      <div className="toolbox-item toolbox-item-proposal">
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
