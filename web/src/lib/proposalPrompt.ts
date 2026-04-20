/**
 * PurpleCloud proposal form + prompt builder.
 * @see https://purple-cloud.ai
 */

export type ProposalEdition = 'enterprise' | 'community'

export type ProposalFormState = {
  odooVersion: string
  edition: '' | ProposalEdition
  erpUserCount: string
  dailyWebsiteVisitors: string
  extraNotes: string
}

export function emptyProposalForm(): ProposalFormState {
  return {
    odooVersion: '',
    edition: '',
    erpUserCount: '',
    dailyWebsiteVisitors: '',
    extraNotes: '',
  }
}

export function validateProposalForm(form: ProposalFormState): { ok: true } | { ok: false; message: string } {
  const v = form.odooVersion.trim()
  if (!v) {
    return { ok: false, message: 'Enter the Odoo version (e.g. 17 or 18).' }
  }
  if (!form.edition) {
    return { ok: false, message: 'Select Odoo Enterprise or Community.' }
  }
  const erpRaw = form.erpUserCount.trim()
  if (!erpRaw) {
    return { ok: false, message: 'Enter the number of ERP users.' }
  }
  if (!/^\d+$/.test(erpRaw)) {
    return { ok: false, message: 'ERP users must be a whole number (digits only, at least 1).' }
  }
  const erp = Number.parseInt(erpRaw, 10)
  if (erp < 1) {
    return { ok: false, message: 'ERP users must be at least 1.' }
  }
  const visRaw = form.dailyWebsiteVisitors.trim()
  if (visRaw && !/^\d+$/.test(visRaw)) {
    return {
      ok: false,
      message: 'Daily website visitors must be a whole number (digits only) or left empty.',
    }
  }
  return { ok: true }
}

/**
 * Builds a user message that asks the model for a PurpleCloud commercial proposal.
 * Call only after `validateProposalForm` succeeds.
 */
export function buildPurpleCloudProposalRequest(form: ProposalFormState): string {
  const editionLabel = form.edition === 'enterprise' ? 'Enterprise' : 'Community'
  const erp = Number.parseInt(form.erpUserCount.trim(), 10)
  const visRaw = form.dailyWebsiteVisitors.trim()
  const visitorsLine =
    visRaw === ''
      ? 'Not specified (optional field left empty).'
      : `${Number.parseInt(visRaw, 10).toLocaleString()} expected daily visitors to the website (e-commerce / public site traffic).`

  const notes = form.extraNotes.trim()
  const notesBlock =
    notes ||
    '(No additional free-form context—the proposal may still mention other assumptions where relevant.)'

  return [
    '[PurpleCloud Proposal]',
    '',
    'You are drafting a commercial proposal for a **dedicated Odoo** hosting deployment using **PurpleCloud** (https://purple-cloud.ai): an Odoo-focused cloud platform with dedicated servers, automated backups, security (including Cloudflare protection), monitoring, Git-based CI/CD, and separate environments (development, staging, production).',
    '',
    '## Confirmed inputs (use exactly as stated; do not change edition or version)',
    `- **Odoo version:** ${form.odooVersion.trim()}`,
    `- **Edition:** ${editionLabel}`,
    `- **ERP users (internal Odoo users):** ${erp.toLocaleString()}`,
    `- **Website / daily visitors:** ${visitorsLine}`,
    '',
    '## Additional context (from user)',
    notesBlock,
    '',
    '## Deliverable',
    'Produce a **professional proposal document** in **Markdown** suitable to send to a prospect. Size infrastructure discussion (workers, RAM, etc.) in light of the ERP user count and website traffic where applicable. Include:',
    '',
    '1. **Executive summary** — business value; why dedicated PurpleCloud versus self-managed infrastructure.',
    '2. **Scope** — explicitly reflect the stated Odoo version and edition; environments (dev / staging / production); modules only where mentioned in additional context.',
    '3. **Architecture (high level)** — dedicated hosting, preferred region or data residency if stated in additional context, connectivity, backup and recovery posture.',
    '4. **Operations** — monitoring, automated backups to secure object storage, maintenance and upgrade cadence, GitHub/GitLab integration if relevant.',
    '5. **Security** — high-level posture; do not fabricate certifications or contractual SLAs.',
    '6. **Assumptions & exclusions** — explicit bullet list.',
    '7. **Commercial structure** — placeholder pricing table or ranges clearly labeled **TBD / indicative only**; never invent binding fees.',
    '8. **Timeline & milestones** — onboarding, UAT, go-live.',
    '9. **Next steps** — information needed from the customer and suggested follow-up.',
    '',
    'Tone: confident, concise, and sales-ready. If information is missing outside the confirmed inputs, note gaps and reasonable options rather than guessing sensitive numbers.',
  ].join('\n')
}
