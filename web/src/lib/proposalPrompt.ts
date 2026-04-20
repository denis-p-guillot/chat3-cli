/**
 * PurpleCloud proposal form + prompt builder.
 * @see https://purple-cloud.ai
 */

import {
  computeLightUserNeed,
  formatRecommendationForPrompt,
  recommendFromGrid,
} from './purpleCloudSizing'
import { PURPLE_CLOUD_PRODUCT_GRID } from './purpleCloudProductGrid'

export type ProposalEdition = 'enterprise' | 'community'

/** Production sizing line: PERFORMANCE instances are named with AWS…; VALUE with DO… */
export type ProposalProductionTier = 'PERFORMANCE' | 'VALUE'

export type ProposalFormState = {
  odooVersion: string
  edition: '' | ProposalEdition
  /** Dedicated production topology: PERFORMANCE (AWS-prefixed instances) vs VALUE (DO-prefixed). */
  productionTier: '' | ProposalProductionTier
  erpUserCount: string
  dailyWebsiteVisitors: string
  extraNotes: string
}

export function emptyProposalForm(): ProposalFormState {
  return {
    odooVersion: '',
    edition: '',
    productionTier: '',
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
  if (!form.productionTier) {
    return { ok: false, message: 'Select production profile: PERFORMANCE or VALUE.' }
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
  if (!form.productionTier) {
    throw new Error('Production profile (PERFORMANCE or VALUE) is required.')
  }
  const editionLabel = form.edition === 'enterprise' ? 'Enterprise' : 'Community'
  const tier: ProposalProductionTier = form.productionTier
  const tierExplain =
    tier === 'PERFORMANCE'
      ? '**PERFORMANCE** — production instances use the **PERFORMANCE** line; instance names **begin with `AWS`**.'
      : '**VALUE** — production instances use the **VALUE** line; instance names **begin with `DO`**.'
  const erp = Number.parseInt(form.erpUserCount.trim(), 10)
  const visRaw = form.dailyWebsiteVisitors.trim()
  const visitorsLine =
    visRaw === ''
      ? 'Not specified (optional field left empty).'
      : `${Number.parseInt(visRaw, 10).toLocaleString()} expected daily visitors to the website (e-commerce / public site traffic).`

  const dailyVisitors = visRaw === '' ? null : Number.parseInt(visRaw, 10)
  const need = computeLightUserNeed(erp, dailyVisitors)
  const rec = recommendFromGrid(PURPLE_CLOUD_PRODUCT_GRID, need, {
    erpUsers: erp,
    dailyVisitors,
    alternateCount: 2,
  })
  const gridSection = formatRecommendationForPrompt(rec)

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
    `- **Production profile:** ${tier} — ${tierExplain} When referencing concrete PurpleCloud instance tiers or catalogs, stay consistent with this profile.`,
    `- **ERP users (internal Odoo users):** ${erp.toLocaleString()}`,
    `- **Website / daily visitors:** ${visitorsLine}`,
    '',
    gridSection,
    '## Additional context (from user)',
    notesBlock,
    '',
    '## Deliverable',
    'Produce a **professional proposal document** in **Markdown** suitable to send to a prospect. **Use `##` headings for each major section** (executive summary, scope, architecture, etc.) so the document maps cleanly to Google Slides. **Infrastructure need and yearly public B2C pricing must follow the “PurpleCloud hosting grid — sizing” section above** (same column meanings as the commercial grid: Product Name, Light users, Cloud Specifications, Workers Odoo, yearly public B2C in USD). Include:',
    '',
    '1. **Executive summary** — business value; why dedicated PurpleCloud versus self-managed infrastructure.',
    '2. **Scope** — explicitly reflect the stated Odoo version and edition; environments (dev / staging / production); modules only where mentioned in additional context.',
    '3. **Architecture (high level)** — align to the **primary** grid recommendation unless you justify an alternate; dedicated hosting, region/data residency from additional context if any.',
    '4. **Operations** — monitoring, backups, maintenance cadence, GitHub/GitLab integration if relevant — consistent with the **Cloud specifications** text of the chosen row(s).',
    '5. **Security** — high-level posture from those specifications; do not fabricate certifications or contractual SLAs.',
    '6. **Assumptions & exclusions** — explicit bullet list (include sizing method: Light user need = ERP users + ceil(daily visitors / 25,000) when visitors are provided).',
    '7. **Commercial structure** — **use the exact Product Name(s) and yearly public B2C (USD) amounts** from the primary (and optionally alternate) rows above. You may label them as public list prices. Do **not** invent SKUs or yearly amounts outside those rows.',
    '8. **Timeline & milestones** — onboarding, UAT, go-live.',
    '9. **Next steps** — information needed from the customer and suggested follow-up.',
    '',
    'Tone: confident, concise, and sales-ready. If information is missing outside the confirmed inputs, note gaps and reasonable options rather than guessing sensitive numbers.',
  ].join('\n')
}
