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

export function formatRecommendationForPrompt(rec: GridRecommendation): string {
  const tierLabel =
    rec.productionTier === 'PERFORMANCE'
      ? 'PERFORMANCE — catalog rows whose **Product Name** starts with `AWS`'
      : 'VALUE — catalog rows whose **Product Name** starts with `DO`'
  const lines: string[] = [
    '## PurpleCloud hosting grid — sizing (mandatory)',
    '',
    `- **Production profile:** ${tierLabel}. Recommendations below are drawn **only** from this slice.`,
    `- **ERP users (input):** ${rec.erpUsers.toLocaleString()} — treated as **heavy** Odoo users (not “light” seats).`,
    `- **ERP → capacity weighting:** each ERP user counts as **${rec.erpHeavyFactor}** light-user capacity units (\`ceil(ERP users × ${rec.erpHeavyFactor})\`) so worker counts align with interactive ERP load.`,
    `- **Expected daily website visitors:** ${
      rec.dailyVisitors == null || rec.dailyVisitors === 0
        ? 'not specified'
        : rec.dailyVisitors.toLocaleString()
    }`,
    `- **Computed capacity need (matches “Light users” column):** ${rec.needLightUsers.toLocaleString()} (= weighted ERP load + visitor load: +1 per 25,000 daily visitors when visitors are provided)`,
    '',
  ]
  if (rec.overflow) {
    lines.push(
      `- **Warning:** No catalog row has **Light users** ≥ ${rec.needLightUsers.toLocaleString()}. The largest **Light users** value in the bundled grid is **${rec.maxLightUsersInGrid.toLocaleString()}**. The rows below are the closest available offerings; call out that **sales / solution architecture must validate** capacity above the grid.`,
      '',
    )
  }
  const fmtRow = (label: string, r: PurpleCloudProductRow) =>
    [
      `### ${label}: \`${r.productName}\``,
      '',
      '| Column | Value |',
      '| --- | --- |',
      `| Light users | ${r.lightUsers} |`,
      `| Workers (Odoo) | ${r.workersOdoo} |`,
      `| Yearly public B2C (USD) | ${r.yearlyPriceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} |`,
      '',
      '**Cloud specifications (verbatim from grid):**',
      '',
      '```',
      r.cloudSpecifications.trim(),
      '```',
      '',
    ].join('\n')

  lines.push(fmtRow('Primary recommendation', rec.primary))
  for (let i = 0; i < rec.alternates.length; i++) {
    lines.push(fmtRow(`Alternate ${i + 1}`, rec.alternates[i]))
  }
  lines.push(
    '**Rules for the proposal:**',
    '',
    '- Base **infrastructure need** and **yearly public pricing** on the rows above only; **do not invent** SKUs or yearly amounts.',
    `- **PERFORMANCE** proposals must reference **AWS-** SKUs only; **VALUE** proposals must reference **DO-** SKUs only (already enforced by the slice above).`,
    '- You may phrase alternatives as “starting from” the primary row; mention alternates briefly.',
    '- If overflow applies, state clearly that sizing exceeds the bundled catalog excerpt and requires validation.',
    '',
  )
  return lines.join('\n')
}
