/**
 * PurpleCloud proposal form + prompt builder.
 * @see https://purple-cloud.ai
 */

import {
  computeLightUserNeed,
  ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
  filterProductGridForProductionTier,
  formatRecommendationForPrompt,
  formatStagingDevDerivedSection,
  PRODUCTION_INSTANCE_SPEC_MULTIPLIER,
  recommendFromGrid,
} from './purpleCloudSizing'
import { PURPLE_CLOUD_PRODUCT_GRID } from './purpleCloudProductGrid'
import { PURPLECLOUD_WIKI_SERVICES_FOR_PROPOSAL_PROMPT } from './proposalPurpleCloudWikiContext'

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
    ? '**PERFORMANCE** — internal high-throughput catalog slice (matching only; do not quote raw product codes to the customer).'
    : '**VALUE** — internal cost-efficient catalog slice (matching only; do not quote raw product codes to the customer).'
}

function tierSkuBlurb(tier: ProposalProductionTier): string {
  return tier === 'PERFORMANCE' ? 'PERFORMANCE tier' : 'VALUE tier'
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
  const needBase = computeLightUserNeed(erp, dailyVisitors, {
    erpHeavyFactor: ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
  })
  const need = form.includeProductionInstance
    ? Math.ceil(needBase * PRODUCTION_INSTANCE_SPEC_MULTIPLIER)
    : needBase
  const rec = recommendFromGrid(tierGrid, need, {
    erpUsers: erp,
    dailyVisitors,
    alternateCount: 2,
    productionTier: catalogTier,
    erpHeavyFactor: ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
  })
  const gridSection = formatRecommendationForPrompt(rec, {
    workerDisplayMultiplier: form.includeProductionInstance ? PRODUCTION_INSTANCE_SPEC_MULTIPLIER : 1,
    productionMatchingNeedBase: form.includeProductionInstance ? needBase : undefined,
  })
  const stagingDevSection = formatStagingDevDerivedSection(rec.primary, {
    includeStaging: form.includeStagingInstance,
    includeDev: form.includeDevInstance,
    primaryWorkerDisplayMultiplier: form.includeProductionInstance ? PRODUCTION_INSTANCE_SPEC_MULTIPLIER : 1,
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

  const diagramSpec =
    'Include **at least one** fenced **Mermaid** diagram (` ```mermaid ` … ` ``` `) in this section: **(a)** reference topology — **Internet / users** → **Cloudflare** (edge) → **Odoo** (workers as sized) → **PostgreSQL** + **filestore**; **(b)** show **Git** (GitHub/GitLab) as the deploy source into the PurpleCloud pipeline when relevant; **(c)** use **subgraphs** only for environments that are **in scope** (Development / Staging / Production), each labeled **VALUE** or **PERFORMANCE** per the confirmed inputs—omit absent environments; keep the graph readable (avoid more than ~12 nodes). Use `flowchart TB` or `flowchart LR`. After the diagram, add a **one-sentence caption** in the proposal language. Optionally add a **second small** Mermaid (e.g. promotion **Dev → Staging → Production** with only included stages).'

  const deliverableArchitecture = form.includeProductionInstance
    ? `3. **Architecture (high level)** — align to the **primary** sizing profile unless you justify an alternate; when **Production** is in scope, **Odoo workers** in the sizing tables are **double** the raw catalog figure (×2) and catalog matching already used **2×** capacity need—**do not** quote internal product codes; relate **file store (GB)** to the proposed worker headroom in plain language; dedicated hosting, region/data residency from additional context if any. ${diagramSpec}`
    : `3. **Architecture (high level)** — align to the **primary** sizing profile unless you justify an alternate; relate **file store (GB)** to the proposed **Odoo worker** headroom in plain language; dedicated hosting, region/data residency from additional context if any. ${diagramSpec}`

  const deliverableExecutiveSummary =
    lang === 'fr'
      ? '1. **Résumé exécutif** — valeur métier; pour le positionnement concurrentiel, utilisez explicitement la tournure **« Par rapport à une infrastructure gérée en interne ou Odoo.SH »** (PurpleCloud dédié vs gestion interne **et** vs l’offre SaaS Odoo.sh).'
      : lang === 'es'
        ? '1. **Resumen ejecutivo** — valor de negocio; por qué un Odoo **dedicado en PurpleCloud** frente a **infraestructura autogestionada/in-house u Odoo.sh** (tratar ambas alternativas).'
        : '1. **Executive summary** — business value; why dedicated **PurpleCloud** versus **self-managed / on-premises infrastructure or Odoo.sh** (treat Odoo.sh as an explicit comparison baseline alongside in-house IT).'

  return [
    '[PurpleCloud Proposal]',
    '',
    'You are drafting a commercial proposal for a **dedicated Odoo** hosting deployment using **PurpleCloud** (https://purple-cloud.ai): an Odoo-focused cloud platform with dedicated servers, automated backups, security (including Cloudflare protection), monitoring, Git-based CI/CD, and separate environments (development, staging, production). **Always** illustrate the proposed infrastructure with **Mermaid** diagram(s) in the Architecture section (see deliverable item 3). Where relevant, surface **integrated console services** (monitoring, PostgreSQL insight, backup/restore, Web SSH) using the **Wiki reference block** below—**with Markdown links**—so due-diligence readers can verify claims.',
    '',
    '## Confirmed inputs (use exactly as stated; do not change edition or version)',
    `- **Language (proposal output):** ${languageLabel} — write the **entire** proposal (all sections, headings, narrative, and bullets) in **${languageLabel}**. Use **Odoo workers** and **public yearly USD** from the sizing section; **do not** paste internal catalog product codes.`,
    `- **Odoo version:** ${form.odooVersion.trim()}`,
    `- **Edition:** ${editionLabel}`,
    '',
    '### Instance / environment plan (mandatory)',
    `- **Development instance:** ${devLine}`,
    `- **Staging instance:** ${stagingLine}`,
    `- **Production instance:** ${prodLine}`,
    `- **Sizing catalog profile (${catalogTier}):** ${tierExplain} The grid below is matched using **${catalogTier}** because: ${sizingDriver} Reflect each included environment in scope; align narrative to **PERFORMANCE** vs **VALUE** per environment without exposing raw catalog strings.`,
    `- **ERP users (internal Odoo users):** ${erp.toLocaleString()}`,
    `- **File store size:** ${fileStoreGb.toLocaleString()} GB — Odoo filestore / attachments the customer needs; compare to the disk implied by the chosen **Odoo worker** profile and state if more storage should be sold separately.`,
    `- **Website / daily visitors:** ${visitorsLine}`,
    ...(form.includeStagingInstance || form.includeDevInstance
      ? [
          '',
          `- **Staging & development specs/pricing:** when included, use the **derived** block after the primary grid — **Staging ≈ 5× smaller** than the anchor (workers + yearly USD ÷ 5), **Development ≈ 8× smaller** (÷ 8). Present them as separate recurring line items alongside production.`,
        ]
      : []),
    '',
    gridSection,
    ...(stagingDevSection.trim() ? ['', stagingDevSection] : []),
    '',
    PURPLECLOUD_WIKI_SERVICES_FOR_PROPOSAL_PROMPT,
    '',
    '## Additional context (from user)',
    notesBlock,
    '',
    '## Deliverable',
    `Produce a **professional proposal document** in **Markdown** suitable to send to a prospect, written entirely in **${languageLabel}**. **Use \`##\` headings for each major section** (executive summary, scope, architecture, etc.) so the document maps cleanly to Google Slides. **Architecture must include Mermaid diagram(s)** as specified under item 3 (Brain AI chat renders \`\`\`mermaid\`\`\` blocks as polished figures). **Capacity and pricing** must follow the “PurpleCloud hosting grid — sizing” section above using **Odoo workers** and **yearly public B2C (USD)** only—**never** quote internal catalog product codes (e.g. host-style SKU strings). When **Staging** / **Development** are included, also use the **derived** workers and USD (anchor ÷5 and ÷8) from that section. Include:`,
    '',
    deliverableExecutiveSummary,
    '2. **Scope** — explicitly reflect the stated Odoo version and edition; environments (dev / staging / production); when **Staging** and/or **Development** are in scope, include their **indicative Odoo workers and yearly USD** from the derived section (≈ **1/5** and **1/8** of the primary anchor); the confirmed **file store (GB)** target; modules only where mentioned in additional context.',
    deliverableArchitecture,
    '4. **Operations** — monitoring, backups, maintenance cadence, GitHub/GitLab integration if relevant — consistent with dedicated Odoo hosting at the proposed **worker** level; **ground** operational claims in the **PurpleCloud integrated services (Wiki reference)** section above (Monitoring; PostgreSQL running queries; Backup & restore; Web SSH) and **include those Wiki links** in Markdown.',
    '5. **Security** — high-level posture appropriate to dedicated Odoo hosting; align narrative to the **Security** Wiki in that same reference block (Cloudflare edge, VALUE vs PERFORMANCE infrastructure themes, Odoo application controls at summary level); **include the Security Wiki link**; do not fabricate certifications or contractual SLAs beyond what the Wiki states.',
    `6. **Assumptions & exclusions** — explicit bullet list (include which of **Development / Staging / Production** instances are in scope; rule: **PERFORMANCE Production ⇒ PERFORMANCE Staging** when both are included; Dev may be PERFORMANCE or VALUE independently; sizing: weighted capacity base = ceil(ERP users × heavy factor) + visitor term;${form.includeProductionInstance ? ' when **Production** is in scope, catalog matching uses **2×** that base and **Workers (Odoo)** in the tables are **2×** the raw catalog figure;' : ''}${form.includeStagingInstance || form.includeDevInstance ? ' **Staging** / **Development** workers and USD are **indicative fractions** (÷5 and ÷8) of the primary anchor, not extra catalog rows;' : ''} internal tier slice follows **PERFORMANCE** vs **VALUE**; ERP users are **heavy** load; include **file store (GB)** vs implied disk).`,
    '7. **Commercial structure** — use the **yearly public B2C (USD)** from the **primary** (and optionally alternate) anchor rows, **plus**—when Staging / Development are in scope—the **derived yearly USD** from the *Staging & development* block as separate recurring lines (≈ **1/5** and **1/8** of anchor list price). **Do not** name internal catalog product codes; anchor on **Odoo workers** and USD.',
    '8. **Timeline & milestones** — onboarding, UAT, go-live.',
    '9. **Next steps** — information needed from the customer and suggested follow-up.',
    '',
    `Tone: confident, concise, and sales-ready — in **${languageLabel}**. If information is missing outside the confirmed inputs, note gaps and reasonable options rather than guessing sensitive numbers.`,
  ].join('\n')
}
