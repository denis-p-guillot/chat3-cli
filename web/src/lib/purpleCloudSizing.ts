/**
 * Sizing + product selection for PurpleCloud proposals.
 * Prices: yearly B2B/B2C (USD/year); 3-year columns are **total USD for the 3-year term** when offered.
 */

import type { PricingAudience } from './purpleCloudPricing'
import { price3yTotalUsd, priceYear1Usd } from './purpleCloudPricing'

export type { PricingAudience } from './purpleCloudPricing'

export type PurpleCloudProductRow = {
  productName: string
  /** "Light users" column — minimum capacity unit for matching */
  lightUsers: number
  cloudSpecifications: string
  workersOdoo: number
  /** Yearly B2B list price (USD / year). */
  priceYearlyB2b: number
  /** Yearly B2C list price (USD / year). */
  priceYearlyB2c: number
  /** Total B2B price for a 3-year commitment (USD), or null if not sold on 3-year terms. */
  price3yB2b: number | null
  /** Total B2C price for a 3-year commitment (USD), or null if not sold on 3-year terms. */
  price3yB2c: number | null
}

/**
 * ERP named users are treated as heavier than generic “light” portal seats: each ERP user
 * counts as this many light-user capacity units when matching the catalog (higher → larger
 * rows with more Odoo workers).
 */
export const ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR = 2

export type ComputeLightUserNeedOptions = {
  /** Defaults to {@link ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR}. */
  erpHeavyFactor?: number
}

/**
 * Capacity need for grid matching: ERP users × heavy factor (ceil) plus visitor load
 * (+1 unit per 25,000 daily visitors when provided).
 */
export function computeLightUserNeed(
  erpUsers: number,
  dailyVisitors: number | null,
  options?: ComputeLightUserNeedOptions,
): number {
  const f = options?.erpHeavyFactor ?? ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR
  let need = Math.ceil(erpUsers * f)
  if (dailyVisitors != null && dailyVisitors > 0) {
    need += Math.ceil(dailyVisitors / 25_000)
  }
  return need
}

/** PERFORMANCE SKUs use AWS-prefixed product names; VALUE SKUs use DO-prefixed names. */
export function filterProductGridForProductionTier(
  grid: PurpleCloudProductRow[],
  tier: 'PERFORMANCE' | 'VALUE',
): PurpleCloudProductRow[] {
  if (tier === 'PERFORMANCE') {
    return grid.filter((r) => r.productName.startsWith('AWS'))
  }
  return grid.filter((r) => r.productName.startsWith('DO'))
}

export type GridRecommendation = {
  needLightUsers: number
  erpUsers: number
  dailyVisitors: number | null
  /** Factor applied to ERP users before matching the “Light users” column (heavy ERP load). */
  erpHeavyFactor: number
  /** Catalog slice: AWS rows for PERFORMANCE, DO rows for VALUE. */
  productionTier: 'PERFORMANCE' | 'VALUE'
  primary: PurpleCloudProductRow
  alternates: PurpleCloudProductRow[]
  overflow: boolean
  maxLightUsersInGrid: number
}

/**
 * Pick the cheapest row that satisfies `lightUsers >= need`.
 * If none, pick the strongest row by **Light users** (then cheapest) — overflow.
 */
export function recommendFromGrid(
  grid: PurpleCloudProductRow[],
  need: number,
  opts: {
    erpUsers: number
    dailyVisitors: number | null
    alternateCount?: number
    productionTier: 'PERFORMANCE' | 'VALUE'
    erpHeavyFactor: number
    /** Used to pick the cheapest qualifying catalog row (1-year list for the selected audience). */
    pricingAudience: PricingAudience
  },
): GridRecommendation {
  if (grid.length === 0) {
    throw new Error('PurpleCloud product grid is empty.')
  }
  const alternateCount = opts.alternateCount ?? 2
  const maxLight = grid.reduce((m, r) => Math.max(m, r.lightUsers), 0)
  const aud = opts.pricingAudience

  const byPrice = [...grid].sort((a, b) => priceYear1Usd(a, aud) - priceYear1Usd(b, aud))
  const satisfying = byPrice.filter((r) => r.lightUsers >= need)
  const overflow = satisfying.length === 0

  const byStrength = [...grid].sort((a, b) => {
    if (b.lightUsers !== a.lightUsers) return b.lightUsers - a.lightUsers
    return priceYear1Usd(a, aud) - priceYear1Usd(b, aud)
  })

  const rowKey = (r: PurpleCloudProductRow) =>
    `${r.productName}\t${r.lightUsers}\t${r.workersOdoo}\t${priceYear1Usd(r, aud)}`

  const primary = overflow ? byStrength[0]! : satisfying[0]!
  const used = new Set<string>([rowKey(primary)])
  const alternates: PurpleCloudProductRow[] = []

  const pool = overflow ? byStrength : satisfying
  for (const row of pool) {
    if (alternates.length >= alternateCount) break
    const k = rowKey(row)
    if (used.has(k)) continue
    if (!overflow && row.lightUsers < need) continue
    alternates.push(row)
    used.add(k)
  }

  if (alternates.length < alternateCount && !overflow) {
    for (const row of byPrice) {
      if (alternates.length >= alternateCount) break
      const k = rowKey(row)
      if (used.has(k)) continue
      if (row.lightUsers < need) continue
      alternates.push(row)
      used.add(k)
    }
  }

  return {
    needLightUsers: need,
    erpUsers: opts.erpUsers,
    dailyVisitors: opts.dailyVisitors,
    erpHeavyFactor: opts.erpHeavyFactor,
    productionTier: opts.productionTier,
    primary,
    alternates,
    overflow,
    maxLightUsersInGrid: maxLight,
  }
}

/** Double production-oriented specs: catalog workers × this in tables; capacity match uses same factor in the builder. */
export const PRODUCTION_INSTANCE_SPEC_MULTIPLIER = 2

/** Indicative staging capacity vs primary (production) anchor — ~5× smaller. */
export const STAGING_VS_PRIMARY_FACTOR = 5
/** Indicative development capacity vs primary anchor — ~8× smaller. */
export const DEV_VS_PRIMARY_FACTOR = 8

/** @deprecated alias — use {@link PRODUCTION_INSTANCE_SPEC_MULTIPLIER} */
export const PRODUCTION_WORKER_DISPLAY_MULTIPLIER = PRODUCTION_INSTANCE_SPEC_MULTIPLIER

export type FormatRecommendationForPromptOptions = {
  /**
   * When not `1`, the **Workers (Odoo)** column shows `catalog workers × multiplier`
   * (default **2** = double for production in scope), with the catalog baseline noted.
   */
  workerDisplayMultiplier?: number
  /** Weighted capacity base before production doubling (for caption only). */
  productionMatchingNeedBase?: number
  /** B2B vs B2C and which yearly / 3-year columns to include in Markdown tables. */
  pricingAudience?: PricingAudience
  showCommitment1y?: boolean
  showCommitment3y?: boolean
}

function formatWorkersDisplayValue(workersOdoo: number): string {
  if (Number.isInteger(workersOdoo)) return String(workersOdoo)
  return String(Math.round(workersOdoo * 100) / 100)
}

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

type ParsedProductShape = {
  provider: string
  vcpu: number | null
  ramGb: number | null
  ssdGb: number | null
  backup: 'Backup' | 'NoBackup' | null
}

function parseProductShape(productName: string): ParsedProductShape {
  const parts = productName.split('-')
  const provider = parts[0] ?? 'N/A'
  let vcpu: number | null = null
  let ramGb: number | null = null
  let ssdGb: number | null = null
  let backup: 'Backup' | 'NoBackup' | null = null
  for (const part of parts) {
    const vcpuMatch = /^(\d+)vcpu$/i.exec(part)
    if (vcpuMatch) vcpu = Number(vcpuMatch[1])
    const ramMatch = /^(\d+)gbram$/i.exec(part)
    if (ramMatch) ramGb = Number(ramMatch[1])
    const ssdMatch = /^(\d+)gbssd$/i.exec(part)
    if (ssdMatch) ssdGb = Number(ssdMatch[1])
    if (part === 'Backup' || part === 'NoBackup') backup = part
  }
  return { provider, vcpu, ramGb, ssdGb, backup }
}

function describeAlternateDifference(
  primary: PurpleCloudProductRow,
  alternate: PurpleCloudProductRow,
  audience: PricingAudience,
  show1y: boolean,
  show3y: boolean,
): string {
  const base = parseProductShape(primary.productName)
  const alt = parseProductShape(alternate.productName)
  const diffs: string[] = []
  if (alt.provider !== base.provider) diffs.push(`provider ${alt.provider} (vs ${base.provider})`)
  if (alt.vcpu !== base.vcpu && alt.vcpu != null && base.vcpu != null) {
    diffs.push(`${alt.vcpu} vCPU (vs ${base.vcpu})`)
  }
  if (alt.ramGb !== base.ramGb && alt.ramGb != null && base.ramGb != null) {
    diffs.push(`${alt.ramGb} GB RAM (vs ${base.ramGb})`)
  }
  if (alt.ssdGb !== base.ssdGb && alt.ssdGb != null && base.ssdGb != null) {
    diffs.push(`${alt.ssdGb} GB SSD (vs ${base.ssdGb})`)
  }
  if (alt.backup !== base.backup && alt.backup != null && base.backup != null) {
    diffs.push(`${alt.backup} (vs ${base.backup})`)
  }
  if (alternate.workersOdoo !== primary.workersOdoo) {
    diffs.push(`catalog workers ${alternate.workersOdoo} (vs ${primary.workersOdoo})`)
  }
  if (alternate.lightUsers !== primary.lightUsers) {
    diffs.push(`light users ${alternate.lightUsers} (vs ${primary.lightUsers})`)
  }

  const priceDiffs: string[] = []
  if (show1y) {
    const yDiff = priceYear1Usd(alternate, audience) - priceYear1Usd(primary, audience)
    const sign = yDiff >= 0 ? '+' : '-'
    priceDiffs.push(`1y ${sign}$${formatUsd(Math.abs(yDiff))}`)
  }
  if (show3y) {
    const a3 = price3yTotalUsd(alternate, audience)
    const p3 = price3yTotalUsd(primary, audience)
    if (a3 != null && p3 != null) {
      const d3 = a3 - p3
      const sign3 = d3 >= 0 ? '+' : '-'
      priceDiffs.push(`3y ${sign3}$${formatUsd(Math.abs(d3))}`)
    } else {
      priceDiffs.push('3y N/A')
    }
  }

  const techDiff = diffs.length > 0 ? diffs.join(', ') : 'same core shape; catalog ordering alternative'
  return `${techDiff}${priceDiffs.length > 0 ? `; price delta: ${priceDiffs.join(', ')}` : ''}`
}

/**
 * Smallest catalog row (by price among ties) in `grid` whose **Light users** covers `lightUserNeed`.
 * Uses the same matching rules as {@link recommendFromGrid} (including overflow to the largest row).
 */
export function pickSmallestCatalogRowForLightNeed(
  grid: PurpleCloudProductRow[],
  lightUserNeed: number,
  tier: 'PERFORMANCE' | 'VALUE',
  pricingAudience: PricingAudience,
): PurpleCloudProductRow {
  const need = Math.max(1, Math.ceil(lightUserNeed))
  return recommendFromGrid(grid, need, {
    erpUsers: 0,
    dailyVisitors: null,
    alternateCount: 0,
    productionTier: tier,
    erpHeavyFactor: ERP_HEAVY_LIGHT_EQUIVALENT_FACTOR,
    pricingAudience,
  }).primary
}

/**
 * **Staging** / **Development** rows: real catalog SKUs from the same tier slice, chosen so each
 * environment’s **Light users** covers a **modeled proxy** (anchor ÷5 and ÷8). **Odoo workers** and
 * **USD** come only from those rows—no fractional worker counts.
 */
export function formatStagingDevDerivedSection(
  primary: PurpleCloudProductRow,
  options: {
    includeStaging: boolean
    includeDev: boolean
    /** Tier slice (AWS or DO rows) used for primary sizing—the same slice is used for staging/dev snaps. */
    tierGrid: PurpleCloudProductRow[]
    catalogTier: 'PERFORMANCE' | 'VALUE'
    pricingAudience: PricingAudience
    showCommitment1y: boolean
    showCommitment3y: boolean
  },
): string {
  const { includeStaging, includeDev, tierGrid, catalogTier } = options
  if (!includeStaging && !includeDev) return ''

  const anchorLight = primary.lightUsers
  const aud = options.pricingAudience
  const audLabel = aud === 'B2B' ? 'B2B' : 'B2C'
  const { header: stagingHeader, separator: stagingSep, formatDataRow: stagingRow } =
    buildPriceTableParts(aud, audLabel, options.showCommitment1y, options.showCommitment3y)

  const lines: string[] = [
    '### Staging & development (catalog-backed rows)',
    '',
    `_Each line below is a **real row** from the same **${catalogTier}** catalog slice as the primary recommendation. **Proxy Light users** = modeled capacity (**primary Light users ÷ ${STAGING_VS_PRIMARY_FACTOR}** for Staging, **÷ ${DEV_VS_PRIMARY_FACTOR}** for Development). The **catalog match** is the **smallest** offering whose **Light users** column is **≥** that proxy (same selection logic as primary sizing). **Odoo workers** and **USD** are taken **only** from that matched row—do not interpolate fractional workers or prices._`,
    '',
  ]

  if (includeStaging) {
    const proxyNeed = Math.max(1, Math.ceil(anchorLight / STAGING_VS_PRIMARY_FACTOR))
    const row = pickSmallestCatalogRowForLightNeed(
      tierGrid,
      anchorLight / STAGING_VS_PRIMARY_FACTOR,
      catalogTier,
      aud,
    )
    lines.push(
      `#### Staging — proxy Light users **≥ ${proxyNeed.toLocaleString()}** (from primary ÷ ${STAGING_VS_PRIMARY_FACTOR})`,
      '',
      stagingHeader,
      stagingSep,
      stagingRow(row),
      '',
    )
  }

  if (includeDev) {
    const proxyNeed = Math.max(1, Math.ceil(anchorLight / DEV_VS_PRIMARY_FACTOR))
    const row = pickSmallestCatalogRowForLightNeed(
      tierGrid,
      anchorLight / DEV_VS_PRIMARY_FACTOR,
      catalogTier,
      aud,
    )
    lines.push(
      `#### Development — proxy Light users **≥ ${proxyNeed.toLocaleString()}** (from primary ÷ ${DEV_VS_PRIMARY_FACTOR})`,
      '',
      stagingHeader,
      stagingSep,
      stagingRow(row),
      '',
    )
  }

  lines.push(
    '- **Proposal use:** present **Staging** / **Development** as separate recurring line items using **only** the worker counts and USD from the tables above (same tier family as production). Do not paste internal product codes.',
    '',
  )

  return lines.join('\n')
}

function buildPriceTableParts(
  audience: PricingAudience,
  audLabel: string,
  show1y: boolean,
  show3y: boolean,
): {
  header: string
  separator: string
  formatDataRow: (r: PurpleCloudProductRow) => string
} {
  const cols: string[] = ['Catalog Light users', '**Odoo workers**']
  if (show1y) cols.push(`Yearly ${audLabel} (1y, USD)`)
  if (show3y) cols.push(`3-year total ${audLabel} (USD)`)
  const header = `| ${cols.join(' | ')} |`
  const separator = `| ${cols.map(() => '---:').join(' | ')} |`
  const formatDataRow = (r: PurpleCloudProductRow) => {
    const cells: string[] = [
      r.lightUsers.toLocaleString(),
      `**${formatWorkersDisplayValue(r.workersOdoo)}**`,
    ]
    if (show1y) cells.push(formatUsd(priceYear1Usd(r, audience)))
    if (show3y) {
      const t3 = price3yTotalUsd(r, audience)
      cells.push(t3 == null ? '*N/A*' : formatUsd(t3))
    }
    return `| ${cells.join(' | ')} |`
  }
  return { header, separator, formatDataRow }
}

export function formatRecommendationForPrompt(
  rec: GridRecommendation,
  options?: FormatRecommendationForPromptOptions,
): string {
  const workerMult = options?.workerDisplayMultiplier ?? 1
  const tierLabel =
    rec.productionTier === 'PERFORMANCE'
      ? '**PERFORMANCE** tier (internal catalog slice only—**never** paste hardware-style product codes to the customer)'
      : '**VALUE** tier (internal catalog slice only—**never** paste hardware-style product codes to the customer)'
  const lines: string[] = [
    '## PurpleCloud hosting grid — sizing (mandatory)',
    '',
    `- **Sizing tier:** ${tierLabel}. Rows below are selected from that slice; communicate sizing to the prospect using **Odoo workers** and the **USD** columns printed below—not raw catalog product codes.`,
    `- **ERP users (input):** ${rec.erpUsers.toLocaleString()} — treated as **heavy** Odoo users (not “light” seats).`,
    `- **ERP → capacity weighting:** each ERP user counts as **${rec.erpHeavyFactor}** light-user capacity units (\`ceil(ERP users × ${rec.erpHeavyFactor})\`) so worker counts align with interactive ERP load.`,
    `- **Expected daily website visitors:** ${
      rec.dailyVisitors == null || rec.dailyVisitors === 0
        ? 'not specified'
        : rec.dailyVisitors.toLocaleString()
    }`,
    ...(options?.productionMatchingNeedBase != null && workerMult !== 1
      ? [
          `- **Computed capacity need (matches “Light users” column for catalog matching):** ${rec.needLightUsers.toLocaleString()} (= **${workerMult}×** the weighted base **${options.productionMatchingNeedBase.toLocaleString()}**, where base = ERP load + visitor load: +1 per 25,000 daily visitors when visitors are provided).`,
          '',
        ]
      : [
          `- **Computed capacity need (matches “Light users” column):** ${rec.needLightUsers.toLocaleString()} (= weighted ERP load + visitor load: +1 per 25,000 daily visitors when visitors are provided)`,
          '',
        ]),
  ]
  if (workerMult !== 1) {
    lines.push(
      `- **Odoo workers (production):** **Workers (Odoo)** in the tables below are **catalog workers × ${workerMult}** (double vs raw catalog for production-grade specs). In the **customer proposal**, lead with these **Odoo worker** targets—do not paste internal SKU / hostname-style strings.`,
      '',
    )
  }
  if (rec.overflow) {
    lines.push(
      `- **Warning:** No catalog row has **Light users** ≥ ${rec.needLightUsers.toLocaleString()}. The largest **Light users** value in the bundled grid is **${rec.maxLightUsersInGrid.toLocaleString()}**. The rows below are the closest available offerings; call out that **sales / solution architecture must validate** capacity above the grid.`,
      '',
    )
  }
  const aud: PricingAudience = options?.pricingAudience ?? 'B2C'
  const audLabel = aud === 'B2B' ? 'B2B' : 'B2C'
  const show1y = options?.showCommitment1y ?? true
  const show3y = options?.showCommitment3y ?? false
  const primaryCols: string[] = ['Slot', 'Light users (catalog)', 'Odoo workers (target)']
  if (show1y) primaryCols.push(`Yearly ${audLabel} (1y, USD)`)
  if (show3y) primaryCols.push(`3-year total ${audLabel} (USD)`)
  const tableLines: string[] = [
    `| ${primaryCols.join(' | ')} |`,
    `| ${primaryCols.map(() => '---:').join(' | ')} |`,
  ]
  const pushTableRow = (slot: string, r: PurpleCloudProductRow) => {
    const workersAdjusted = r.workersOdoo * workerMult
    const workersCell =
      workerMult !== 1
        ? `**${formatWorkersDisplayValue(workersAdjusted)}** (${formatWorkersDisplayValue(r.workersOdoo)} × ${workerMult})`
        : `**${formatWorkersDisplayValue(workersAdjusted)}**`
    const cells: string[] = [`**${slot}**`, r.lightUsers.toLocaleString(), workersCell]
    if (show1y) cells.push(formatUsd(priceYear1Usd(r, aud)))
    if (show3y) {
      const t3 = price3yTotalUsd(r, aud)
      cells.push(t3 == null ? '*N/A*' : formatUsd(t3))
    }
    tableLines.push(`| ${cells.join(' | ')} |`)
  }
  pushTableRow('Primary recommendation', rec.primary)
  for (let i = 0; i < rec.alternates.length; i++) {
    pushTableRow(`Alternate ${i + 1}`, rec.alternates[i])
  }
  const priceRule =
    show1y && show3y
      ? `**1-year** and **3-year** (${audLabel}) amounts in the table; 3-year values are **total USD for the three-year term** where the catalog lists them.`
      : show3y
        ? `**3-year total** (${audLabel}) only where shown; values are **total USD for the three-year term**.`
        : `**Yearly** (${audLabel}, 1-year list) amounts in the table.`
  lines.push(
    '_Internal catalog rows—do not disclose SKU / product codes to the customer._',
    '',
    ...tableLines,
    '',
    '**Alternate differences vs primary (explicit):**',
    '',
    ...rec.alternates.map(
      (alt, i) => `- **Alternate ${i + 1}:** ${describeAlternateDifference(rec.primary, alt, aud, show1y, show3y)}`,
    ),
    '',
    '**Rules for the proposal:**',
    '',
    '- **Odoo workers** and **USD** in customer-facing text must match **exactly** the numeric values in the table above (primary and alternates)—these are the only catalog-backed targets for this tier slice; **do not** round to other worker counts or invent capacities.',
    '- Present **all dollar amounts** for hosting tiers in the **Commercial** section (and anywhere recurring PurpleCloud fees appear) using **GitHub-Flavored Markdown tables** with a header row, aligned numeric columns, and **one row per line item**—**no** bare inline prices for those amounts.',
    `- Base prices on the **${audLabel}** column(s) above (${priceRule}) **Do not invent** prices. **Do not** include internal catalog product codes in customer-facing text—describe technical sizing with **Odoo workers** from the table only.`,
    ...(workerMult !== 1
      ? [
          `- **Production doubling:** catalog matching and **Odoo workers** already use **×${workerMult}** for production in scope; keep that headroom in the narrative.`,
        ]
      : []),
    '- **PERFORMANCE** vs **VALUE** is enforced by the internal tier slice only—never paste raw SKU strings to the prospect.',
    '- You may phrase alternatives as “starting from” the primary row; mention alternates briefly.',
    '- If overflow applies, state clearly that sizing exceeds the bundled catalog excerpt and requires validation.',
    '',
  )
  return lines.join('\n')
}
