import type { ProposalFormState, ProposalProductionTier } from '../lib/proposalPrompt'

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
            <span className="form-label-caption">
              Language <span className="req">*</span>
            </span>
            <select
              value={proposalForm.proposalLanguage}
              onChange={(e) =>
                onProposalFormChange({
                  proposalLanguage: e.target.value as ProposalFormState['proposalLanguage'],
                })
              }
            >
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
            </select>
            <span className="muted toolbox-field-hint">Language of the generated proposal document (default: English).</span>
          </label>
          <label>
            <span className="form-label-caption">
              Odoo version <span className="req">*</span>
            </span>
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
            <span className="form-label-caption">
              Edition <span className="req">*</span>
            </span>
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
          <div className="toolbox-env-section">
            <p className="toolbox-env-section-title">Odoo instances</p>
            <p className="muted toolbox-field-hint toolbox-env-intro">
              Include or exclude each environment. Catalog sizing uses <strong>Production</strong> tier when production
              is included; otherwise <strong>Staging</strong>, otherwise <strong>Development</strong>.{' '}
              <strong>PERFORMANCE</strong> Production requires <strong>PERFORMANCE</strong> Staging. Dev may be{' '}
              <strong>PERFORMANCE</strong> or <strong>VALUE</strong> independently.
            </p>
            <label className="toolbox-env-toggle">
              <input
                type="checkbox"
                checked={proposalForm.includeDevInstance}
                onChange={(e) => onProposalFormChange({ includeDevInstance: e.target.checked })}
              />
              <span>Development instance</span>
            </label>
            {proposalForm.includeDevInstance && (
              <div className="toolbox-env-nested">
                <label>
                  <span className="form-label-caption">
                    Dev tier <span className="req">*</span>
                  </span>
                  <select
                    value={proposalForm.devInstanceTier}
                    onChange={(e) =>
                      onProposalFormChange({
                        devInstanceTier: e.target.value as ProposalProductionTier,
                      })
                    }
                  >
                    <option value="PERFORMANCE">PERFORMANCE (AWS)</option>
                    <option value="VALUE">VALUE (DO)</option>
                  </select>
                </label>
              </div>
            )}
            <label className="toolbox-env-toggle">
              <input
                type="checkbox"
                checked={proposalForm.includeStagingInstance}
                onChange={(e) => {
                  const on = e.target.checked
                  if (
                    on &&
                    proposalForm.includeProductionInstance &&
                    proposalForm.productionTier === 'PERFORMANCE'
                  ) {
                    onProposalFormChange({ includeStagingInstance: true, stagingInstanceTier: 'PERFORMANCE' })
                  } else {
                    onProposalFormChange({ includeStagingInstance: on })
                  }
                }}
              />
              <span>Staging instance</span>
            </label>
            {proposalForm.includeStagingInstance && (
              <div className="toolbox-env-nested">
                {proposalForm.includeProductionInstance && proposalForm.productionTier === 'PERFORMANCE' ? (
                  <p className="muted toolbox-env-locked">
                    Staging tier is <strong>PERFORMANCE (AWS)</strong> — required when Production is PERFORMANCE.
                  </p>
                ) : (
                  <label>
                    <span className="form-label-caption">
                      Staging tier <span className="req">*</span>
                    </span>
                    <select
                      value={proposalForm.stagingInstanceTier}
                      onChange={(e) =>
                        onProposalFormChange({
                          stagingInstanceTier: e.target.value as ProposalProductionTier,
                        })
                      }
                    >
                      <option value="PERFORMANCE">PERFORMANCE (AWS)</option>
                      <option value="VALUE">VALUE (DO)</option>
                    </select>
                  </label>
                )}
              </div>
            )}
            <label className="toolbox-env-toggle">
              <input
                type="checkbox"
                checked={proposalForm.includeProductionInstance}
                onChange={(e) => {
                  const on = e.target.checked
                  onProposalFormChange(
                    on
                      ? { includeProductionInstance: true }
                      : { includeProductionInstance: false, productionTier: '' },
                  )
                }}
              />
              <span>Production instance</span>
            </label>
            {proposalForm.includeProductionInstance && (
              <div className="toolbox-env-nested">
                <label>
                  <span className="form-label-caption">
                    Production tier <span className="req">*</span>
                  </span>
                  <select
                    value={proposalForm.productionTier}
                    onChange={(e) => {
                      const v = e.target.value as ProposalFormState['productionTier']
                      const patch: Partial<ProposalFormState> = { productionTier: v }
                      if (proposalForm.includeStagingInstance && v === 'PERFORMANCE') {
                        patch.stagingInstanceTier = 'PERFORMANCE'
                      }
                      onProposalFormChange(patch)
                    }}
                  >
                    <option value="">Select…</option>
                    <option value="PERFORMANCE">PERFORMANCE (AWS)</option>
                    <option value="VALUE">VALUE (DO)</option>
                  </select>
                </label>
                <span className="muted toolbox-field-hint">
                  Sizing grid follows this tier when production is included. ERP users are counted as{' '}
                  <strong>heavy</strong> load vs catalog “light users”.
                </span>
              </div>
            )}
          </div>
          <label>
            <span className="form-label-caption">
              Number of ERP users <span className="req">*</span>
            </span>
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
            <span className="form-label-caption">
              File store size in GB <span className="req">*</span>
            </span>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="Odoo filestore / attachments (e.g. 50, 100)"
              value={proposalForm.fileStoreSizeGb}
              onChange={(e) => onProposalFormChange({ fileStoreSizeGb: e.target.value })}
            />
            <span className="muted toolbox-field-hint">Total GB for Odoo filestore and attachments the prospect needs.</span>
          </label>
          <label>
            <span className="form-label-caption">
              Expected daily website visitors <span className="optional">(optional)</span>
            </span>
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
          <span className="form-label-caption">
            Additional context <span className="optional">(optional)</span>
          </span>
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
