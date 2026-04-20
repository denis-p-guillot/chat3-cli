/**
 * PurpleCloud proposal form + prompt builder.
 * @see https://purple-cloud.ai
 */

import {
  computeLightUserNeed,
  ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
  filterProductGridForProductionTier,
  formatRecommendationForPrompt,
  PRODUCTION_WORKER_DISPLAY_MULTIPLIER,
  recommendFromGrid,
} from './purpleCloudSizing'
import { PURPLE_CLOUD_PRODUCT_GRID } from './purpleCloudProductGrid'

export type ProposalEdition = 'enterprise' | 'community'

/** Production sizing line: PERFORMANCE instances are named with AWS…; VALUE with DO… */
export type ProposalProductionTier = 'PERFORMANCE' | 'VALUE'

/** Language for the generated proposal text (default English). */
export type ProposalLanguage = 'en' | 'fr' | 'es'

export type ProposalFormState = {
  /** Proposal document language (default English). */
  proposalLanguage: ProposalLanguage
  odooVersion: string
  edition: '' | ProposalEdition
  /** Include a dedicated development Odoo instance in the proposal. */
  includeDevInstance: boolean
  /** Dev may be PERFORMANCE (AWS) or VALUE (DO); only used when {@link includeDevInstance}. */
  devInstanceTier: ProposalProductionTier
  /** Include a dedicated staging Odoo instance. */
  includeStagingInstance: boolean
  /**
   * Staging tier when not forced to PERFORMANCE.
   * If Production is included and PERFORMANCE, staging must be PERFORMANCE (see {@link effectiveStagingInstanceTier}).
   */
  stagingInstanceTier: ProposalProductionTier
  /** Include production. When true, {@link productionTier} must be set. */
  includeProductionInstance: boolean
  /** Production instance tier (AWS vs DO catalog); drives sizing when production is included. */
  productionTier: '' | ProposalProductionTier
  erpUserCount: string
  /** Odoo filestore / attachment storage target (gigabytes), whole number. */
  fileStoreSizeGb: string
  dailyWebsiteVisitors: string
  extraNotes: string
}

export function emptyProposalForm(): ProposalFormState {
  return {
    proposalLanguage: 'en',
    odooVersion: '',
    edition: '',
    includeDevInstance: true,
    devInstanceTier: 'VALUE',
    includeStagingInstance: true,
    stagingInstanceTier: 'VALUE',
    includeProductionInstance: true,
    productionTier: '',
    erpUserCount: '',
    fileStoreSizeGb: '',
    dailyWebsiteVisitors: '',
    extraNotes: '',
  }
}

export function validateProposalForm(form: ProposalFormState): { ok: true } | { ok: false; message: string } {
  if (form.proposalLanguage !== 'en' && form.proposalLanguage !== 'fr' && form.proposalLanguage !== 'es') {
    return { ok: false, message: 'Select proposal language: English, French, or Spanish.' }
  }
  const v = form.odooVersion.trim()
  if (!v) {
    return { ok: false, message: 'Enter the Odoo version (e.g. 17 or 18).' }
  }
  if (!form.edition) {
    return { ok: false, message: 'Select Odoo Enterprise or Community.' }
  }
  if (!form.includeDevInstance && !form.includeStagingInstance && !form.includeProductionInstance) {
    return {
      ok: false,
      message: 'Select at least one environment: Development, Staging, and/or Production instance.',
    }
  }
  if (form.includeProductionInstance && !form.productionTier) {
    return {
      ok: false,
      message: 'Select Production instance tier (PERFORMANCE or VALUE), or turn off Production instance.',
    }
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
  const fsRaw = form.fileStoreSizeGb.trim()
  if (!fsRaw) {
    return { ok: false, message: 'Enter file store size in GB (whole number, at least 1).' }
  }
  if (!/^\d+$/.test(fsRaw)) {
    return { ok: false, message: 'File store size must be a whole number of GB (digits only, at least 1).' }
  }
  const fileGb = Number.parseInt(fsRaw, 10)
  if (fileGb < 1) {
    return { ok: false, message: 'File store size must be at least 1 GB.' }
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

/** Staging tier after rule: PERFORMANCE Production ⇒ PERFORMANCE Staging. Only call when staging is included. */
export function effectiveStagingInstanceTier(form: ProposalFormState): ProposalProductionTier {
  if (!form.includeStagingInstance) {
    throw new Error('effectiveStagingInstanceTier: staging instance not included.')
  }
  if (form.includeProductionInstance && form.productionTier === 'PERFORMANCE') {
    return 'PERFORMANCE'
  }
  return form.stagingInstanceTier
}

/**
 * Which catalog slice (AWS vs DO) sizes the grid: Production if included, else Staging, else Dev.
 */
export function resolveCatalogTierForSizing(form: ProposalFormState): ProposalProductionTier {
  if (form.includeProductionInstance && form.productionTier) {
    return form.productionTier
  }
  if (form.includeStagingInstance) {
    return effectiveStagingInstanceTier(form)
  }
  if (form.includeDevInstance) {
    return form.devInstanceTier
  }
  throw new Error('No environment tier available for catalog sizing.')
}

function tierCatalogExplain(tier: ProposalProductionTier): string {
  return tier === 'PERFORMANCE'
    ? '**PERFORMANCE** — catalog SKUs whose names **begin with `AWS`**.'
    : '**VALUE** — catalog SKUs whose names **begin with `DO`**.'
}

function tierSkuBlurb(tier: ProposalProductionTier): string {
  return tier === 'PERFORMANCE'
    ? 'PERFORMANCE (AWS-prefixed catalog SKUs)'
    : 'VALUE (DO-prefixed catalog SKUs)'
}

/**
 * Builds a user message that asks the model for a PurpleCloud commercial proposal.
 * Call only after `validateProposalForm` succeeds.
 */
export function buildPurpleCloudProposalRequest(form: ProposalFormState): string {
  const catalogTier = resolveCatalogTierForSizing(form)
  const lang = form.proposalLanguage
  const languageLabel =
    lang === 'en' ? 'English' : lang === 'fr' ? 'French' : 'Spanish'
  const editionLabel = form.edition === 'enterprise' ? 'Enterprise' : 'Community'
  const stagingEff: ProposalProductionTier | null = form.includeStagingInstance
    ? effectiveStagingInstanceTier(form)
    : null
  const tierExplain = tierCatalogExplain(catalogTier)
  const erp = Number.parseInt(form.erpUserCount.trim(), 10)
  const fileStoreGb = Number.parseInt(form.fileStoreSizeGb.trim(), 10)
  const visRaw = form.dailyWebsiteVisitors.trim()
  const visitorsLine =
    visRaw === ''
      ? 'Not specified (optional field left empty).'
      : `${Number.parseInt(visRaw, 10).toLocaleString()} expected daily visitors to the website (e-commerce / public site traffic).`

  const dailyVisitors = visRaw === '' ? null : Number.parseInt(visRaw, 10)
  const tierGrid = filterProductGridForProductionTier(PURPLE_CLOUD_PRODUCT_GRID, catalogTier)
  if (tierGrid.length === 0) {
    throw new Error(
      catalogTier === 'PERFORMANCE'
        ? 'No AWS (PERFORMANCE) catalog rows are available for sizing.'
        : 'No DO (VALUE) catalog rows are available for sizing.',
    )
  }
  const need = computeLightUserNeed(erp, dailyVisitors, {
    erpHeavyFactor: ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
  })
  const rec = recommendFromGrid(tierGrid, need, {
    erpUsers: erp,
    dailyVisitors,
    alternateCount: 2,
    productionTier: catalogTier,
    erpHeavyFactor: ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
  })
  const gridSection = formatRecommendationForPrompt(rec, {
    workerDisplayMultiplier: form.includeProductionInstance
      ? PRODUCTION_WORKER_DISPLAY_MULTIPLIER
      : 1,
  })

  const notes = form.extraNotes.trim()
  const notesBlock =
    notes ||
    '(No additional free-form context—the proposal may still mention other assumptions where relevant.)'

  const devLine = form.includeDevInstance
    ? `**Included** — ${tierSkuBlurb(form.devInstanceTier)}.`
    : '**Not included** — do not propose a dedicated development instance unless additional context contradicts this.'
  const stagingLine = !form.includeStagingInstance
    ? '**Not included** — do not propose a dedicated staging instance unless additional context contradicts this.'
    : `**Included** — ${tierSkuBlurb(stagingEff!)}.${
        form.includeProductionInstance && form.productionTier === 'PERFORMANCE'
          ? ' _(Rule: PERFORMANCE Production requires PERFORMANCE Staging.)_'
          : ''
      }`
  const prodLine = form.includeProductionInstance
    ? `**Included** — ${tierSkuBlurb(form.productionTier as ProposalProductionTier)}.`
    : '**Not included** — do not propose a dedicated production instance from this sizing run; the grid below still reflects the **sizing catalog profile** for the included environment(s).'

  const sizingDriver =
    form.includeProductionInstance && form.productionTier
      ? '**Production** instance tier (production included).'
      : form.includeStagingInstance
        ? '**Staging** instance tier (production not included or tier taken from staging).'
        : '**Development** instance tier (only development included).'

  const deliverableArchitecture = form.includeProductionInstance
    ? '3. **Architecture (high level)** — align to the **primary** grid recommendation unless you justify an alternate; when **Production** is in scope, use the **Workers (Odoo)** values from the sizing tables (**catalog × 1.5**, +50% headroom for production); reconcile grid **SSD / storage** with the stated **file store (GB)**; dedicated hosting, region/data residency from additional context if any.'
    : '3. **Architecture (high level)** — align to the **primary** grid recommendation unless you justify an alternate; reconcile grid **SSD / storage** with the stated **file store (GB)**; dedicated hosting, region/data residency from additional context if any.'

  return [
    '[PurpleCloud Proposal]',
    '',
    'You are drafting a commercial proposal for a **dedicated Odoo** hosting deployment using **PurpleCloud** (https://purple-cloud.ai): an Odoo-focused cloud platform with dedicated servers, automated backups, security (including Cloudflare protection), monitoring, Git-based CI/CD, and separate environments (development, staging, production).',
    '',
    '## Confirmed inputs (use exactly as stated; do not change edition or version)',
    `- **Language (proposal output):** ${languageLabel} — write the **entire** proposal (all sections, headings, narrative, and bullets) in **${languageLabel}**. Product names, technical labels, and USD amounts from the sizing grid may match the grid verbatim where needed.`,
    `- **Odoo version:** ${form.odooVersion.trim()}`,
    `- **Edition:** ${editionLabel}`,
    '',
    '### Instance / environment plan (mandatory)',
    `- **Development instance:** ${devLine}`,
    `- **Staging instance:** ${stagingLine}`,
    `- **Production instance:** ${prodLine}`,
    `- **Sizing catalog profile (${catalogTier}):** ${tierExplain} The hosting grid below is matched using **${catalogTier}** because: ${sizingDriver} Reflect each included environment in scope and pricing narrative; use the grid row(s) for the sizing profile and align other environments to the correct SKU families (AWS vs DO) per their tiers.`,
    `- **ERP users (internal Odoo users):** ${erp.toLocaleString()}`,
    `- **File store size:** ${fileStoreGb.toLocaleString()} GB — Odoo filestore / attachments storage the customer needs (compare to **SSD storage** in the grid’s cloud specifications; state if the primary SKU is tight, adequate, or undersized and whether upsell / add-on storage is needed).`,
    `- **Website / daily visitors:** ${visitorsLine}`,
    '',
    gridSection,
    '## Additional context (from user)',
    notesBlock,
    '',
    '## Deliverable',
    `Produce a **professional proposal document** in **Markdown** suitable to send to a prospect, written entirely in **${languageLabel}** (except where quoting grid product names/figures). **Use \`##\` headings for each major section** (executive summary, scope, architecture, etc.) so the document maps cleanly to Google Slides. **Infrastructure need and yearly public B2C pricing must follow the “PurpleCloud hosting grid — sizing” section above** (same column meanings as the commercial grid: Product Name, Light users, Cloud Specifications, Workers Odoo, yearly public B2C in USD). Include:`,
    '',
    '1. **Executive summary** — business value; why dedicated PurpleCloud versus self-managed infrastructure.',
    '2. **Scope** — explicitly reflect the stated Odoo version and edition; environments (dev / staging / production); the confirmed **file store (GB)** target; modules only where mentioned in additional context.',
    deliverableArchitecture,
    '4. **Operations** — monitoring, backups, maintenance cadence, GitHub/GitLab integration if relevant — consistent with the **Cloud specifications** text of the chosen row(s).',
    '5. **Security** — high-level posture from those specifications; do not fabricate certifications or contractual SLAs.',
    `6. **Assumptions & exclusions** — explicit bullet list (include which of **Development / Staging / Production** instances are in scope; rule: **PERFORMANCE Production ⇒ PERFORMANCE Staging** when both are included; Dev may be PERFORMANCE or VALUE independently; sizing method: capacity need = ceil(ERP users × heavy factor) + ceil(daily visitors / 25,000) when visitors are provided; catalog slice is **AWS-only for PERFORMANCE** and **DO-only for VALUE** per the sizing profile; ERP users are **heavy** load;${form.includeProductionInstance ? ' when **Production** is in scope, **Workers (Odoo)** in the sizing tables are **+50%** vs catalog baseline;' : ''} include **file store (GB)** vs catalog disk).`,
    '7. **Commercial structure** — **use the exact Product Name(s) and yearly public B2C (USD) amounts** from the primary (and optionally alternate) rows above. You may label them as public list prices. Do **not** invent SKUs or yearly amounts outside those rows.',
    '8. **Timeline & milestones** — onboarding, UAT, go-live.',
    '9. **Next steps** — information needed from the customer and suggested follow-up.',
    '',
    `Tone: confident, concise, and sales-ready — in **${languageLabel}**. If information is missing outside the confirmed inputs, note gaps and reasonable options rather than guessing sensitive numbers.`,
  ].join('\n')
}
