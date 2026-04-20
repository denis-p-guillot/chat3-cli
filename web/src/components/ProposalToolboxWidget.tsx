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

function InfoTip({ text }: { text: string }) {
  return (
    <span className="toolbox-info-tip" title={text} aria-label={text}>
      ?
    </span>
  )
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
        <p className="muted toolbox-help">Fill required fields, then run to generate the commercial proposal.</p>
        <div className="toolbox-form">
          <label>
            <span className="form-label-caption">
              Language <span className="req">*</span>
              <InfoTip text="Language of the generated proposal document." />
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
          </label>
          <div className="toolbox-pricing-section">
            <p className="toolbox-env-section-title">
              Catalog pricing
              <InfoTip text="Choose B2B (business/partner) or B2C (public list), then select which commitment columns to include in proposal tables." />
            </p>
            <label>
              <span className="form-label-caption">
                Price book <span className="req">*</span>
              </span>
              <select
                value={proposalForm.pricingAudience}
                onChange={(e) =>
                  onProposalFormChange({
                    pricingAudience: e.target.value as ProposalFormState['pricingAudience'],
                  })
                }
              >
                <option value="B2C">B2C (yearly list)</option>
                <option value="B2B">B2B (yearly list)</option>
              </select>
            </label>
            <div className="toolbox-commitment-row">
              <label className="toolbox-env-toggle toolbox-check-chip">
                <input
                  type="checkbox"
                  checked={proposalForm.commitmentOneYear}
                  onChange={(e) => {
                    const next = e.target.checked
                    if (!next && !proposalForm.commitmentThreeYear) {
                      onProposalFormChange({ commitmentOneYear: false, commitmentThreeYear: true })
                    } else {
                      onProposalFormChange({ commitmentOneYear: next })
                    }
                  }}
                />
                <span className="toolbox-check-chip-label">1-year</span>
                <InfoTip text="Include yearly USD pricing column." />
              </label>
              <label className="toolbox-env-toggle toolbox-check-chip">
                <input
                  type="checkbox"
                  checked={proposalForm.commitmentThreeYear}
                  onChange={(e) => {
                    const next = e.target.checked
                    if (!next && !proposalForm.commitmentOneYear) {
                      onProposalFormChange({ commitmentThreeYear: false, commitmentOneYear: true })
                    } else {
                      onProposalFormChange({ commitmentThreeYear: next })
                    }
                  }}
                />
                <span className="toolbox-check-chip-label">3-year</span>
                <InfoTip text="Include total USD for a 3-year commitment (where published)." />
              </label>
            </div>
          </div>
          <label>
            <span className="form-label-caption">
              Odoo version <span className="req">*</span>
              <InfoTip text="Target Odoo major version(s), e.g. 17, 18, 19." />
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
              <InfoTip text="Choose Enterprise or Community edition." />
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
            <p className="toolbox-env-section-title">
              Odoo instances
              <InfoTip text="Include/exclude each environment. If Production is included, sizing follows Production tier; otherwise Staging, otherwise Development. PERFORMANCE Production requires PERFORMANCE Staging." />
            </p>
            <div className="toolbox-instance-card">
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
                      <InfoTip text="Catalog family for Development: PERFORMANCE (AWS) or VALUE (DO)." />
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
            </div>
            <div className="toolbox-instance-card">
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
                        <InfoTip text="Catalog family for Staging: PERFORMANCE (AWS) or VALUE (DO)." />
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
            </div>
            <div className="toolbox-instance-card">
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
                      <InfoTip text="Catalog family for Production. PERFORMANCE uses AWS rows; VALUE uses DO rows." />
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
                </div>
              )}
            </div>
          </div>
          <label>
            <span className="form-label-caption">
              Number of ERP users <span className="req">*</span>
              <InfoTip text="Named/billable Odoo users. Used in catalog sizing (ERP users are weighted as heavy load)." />
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
              <InfoTip text="Total filestore/attachments size needed by the customer (GB)." />
            </span>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="Odoo filestore / attachments (e.g. 50, 100)"
              value={proposalForm.fileStoreSizeGb}
              onChange={(e) => onProposalFormChange({ fileStoreSizeGb: e.target.value })}
            />
          </label>
          <label>
            <span className="form-label-caption">
              Expected daily website visitors <span className="optional">(optional)</span>
              <InfoTip text="Public/e-commerce traffic. Leave empty if not applicable." />
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
            <InfoTip text="Customer name, regions, key modules, integrations, constraints, and timeline." />
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
