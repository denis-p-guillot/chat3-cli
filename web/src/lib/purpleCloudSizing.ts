/**
 * Sizing + product selection for PurpleCloud proposals.
 * Yearly "y b2c" = public B2C USD price per year.
 */

export type PurpleCloudProductRow = {
  productName: string
  /** "Light users" column — minimum capacity unit for matching */
  lightUsers: number
  cloudSpecifications: string
  workersOdoo: number
  /** Yearly public B2C price (USD) */
  yearlyPriceUsd: number
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
  },
): GridRecommendation {
  if (grid.length === 0) {
    throw new Error('PurpleCloud product grid is empty.')
  }
  const alternateCount = opts.alternateCount ?? 2
  const maxLight = grid.reduce((m, r) => Math.max(m, r.lightUsers), 0)

  const byPrice = [...grid].sort((a, b) => a.yearlyPriceUsd - b.yearlyPriceUsd)
  const satisfying = byPrice.filter((r) => r.lightUsers >= need)
  const overflow = satisfying.length === 0

  const byStrength = [...grid].sort((a, b) => {
    if (b.lightUsers !== a.lightUsers) return b.lightUsers - a.lightUsers
    return a.yearlyPriceUsd - b.yearlyPriceUsd
  })

  const rowKey = (r: PurpleCloudProductRow) =>
    `${r.productName}\t${r.lightUsers}\t${r.workersOdoo}\t${r.yearlyPriceUsd}`

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
}

function formatWorkersDisplayValue(workersOdoo: number): string {
  if (Number.isInteger(workersOdoo)) return String(workersOdoo)
  return String(Math.round(workersOdoo * 100) / 100)
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
    `- **Sizing tier:** ${tierLabel}. Rows below are selected from that slice; communicate sizing to the prospect using **Odoo workers** (and public yearly amounts)—not raw catalog product codes.`,
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
  const fmtRow = (label: string, r: PurpleCloudProductRow) => {
    const workersAdjusted = r.workersOdoo * workerMult
    const workersCell =
      workerMult !== 1
        ? `${formatWorkersDisplayValue(workersAdjusted)} (catalog ${formatWorkersDisplayValue(r.workersOdoo)} × ${workerMult} for production)`
        : formatWorkersDisplayValue(r.workersOdoo)
    return [
      `### ${label}`,
      '_Internal row — do not disclose catalog SKU / product code to the customer._',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      `| Light users (catalog) | ${r.lightUsers} |`,
      `| **Odoo workers (target)** | **${workersCell}** |`,
      `| Yearly public B2C (USD) | ${r.yearlyPriceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} |`,
      '',
    ].join('\n')
  }

  lines.push(fmtRow('Primary recommendation', rec.primary))
  for (let i = 0; i < rec.alternates.length; i++) {
    lines.push(fmtRow(`Alternate ${i + 1}`, rec.alternates[i]))
  }
  lines.push(
    '**Rules for the proposal:**',
    '',
    '- Base **yearly public B2C (USD)** on the amounts above only; **do not invent** prices. **Do not** include internal catalog product codes in customer-facing text—describe technical sizing with **Odoo workers** from the table only.',
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
