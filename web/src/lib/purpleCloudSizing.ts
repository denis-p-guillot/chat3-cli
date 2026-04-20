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

export function computeLightUserNeed(erpUsers: number, dailyVisitors: number | null): number {
  let need = erpUsers
  if (dailyVisitors != null && dailyVisitors > 0) {
    need += Math.ceil(dailyVisitors / 25_000)
  }
  return need
}

export type GridRecommendation = {
  needLightUsers: number
  erpUsers: number
  dailyVisitors: number | null
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
  opts: { erpUsers: number; dailyVisitors: number | null; alternateCount?: number },
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
    primary,
    alternates,
    overflow,
    maxLightUsersInGrid: maxLight,
  }
}

export function formatRecommendationForPrompt(rec: GridRecommendation): string {
  const lines: string[] = [
    '## PurpleCloud hosting grid — sizing (mandatory)',
    '',
    `- **ERP users (input):** ${rec.erpUsers.toLocaleString()}`,
    `- **Expected daily website visitors:** ${
      rec.dailyVisitors == null || rec.dailyVisitors === 0
        ? 'not specified'
        : rec.dailyVisitors.toLocaleString()
    }`,
    `- **Computed “light user” need:** ${rec.needLightUsers.toLocaleString()} (ERP users plus visitor load: +1 per 25,000 daily visitors when visitors are provided)`,
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
    '- You may phrase alternatives as “starting from” the primary row; mention alternates briefly.',
    '- If overflow applies, state clearly that sizing exceeds the bundled catalog excerpt and requires validation.',
    '',
  )
  return lines.join('\n')
}
