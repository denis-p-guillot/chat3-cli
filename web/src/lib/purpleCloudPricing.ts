export type PricingAudience = 'B2B' | 'B2C'

/** Minimal price fields (matches {@link PurpleCloudProductRow}). */
export type PurpleCloudPriceFields = {
  priceYearlyB2b: number
  priceYearlyB2c: number
  price3yB2b: number | null
  price3yB2c: number | null
}

/** Which commitment period(s) to show in the proposal tables (at least one). */
export type CommitmentSelection = {
  /** 1-year term (yearly list prices). */
  oneYear: boolean
  /** 3-year term (total contract value for three years, per catalog). */
  threeYear: boolean
}

export type ProposalPricingOptions = {
  audience: PricingAudience
  commitment: CommitmentSelection
}

/** 1-year unit price (USD / year) for catalog matching / sorting. */
export function priceYear1Usd(row: PurpleCloudPriceFields, audience: PricingAudience): number {
  return audience === 'B2B' ? row.priceYearlyB2b : row.priceYearlyB2c
}

/** Whether a 3-year total exists for this row and audience. */
export function hasPrice3y(row: PurpleCloudPriceFields, audience: PricingAudience): boolean {
  return audience === 'B2B' ? row.price3yB2b != null : row.price3yB2c != null
}

export function price3yTotalUsd(row: PurpleCloudPriceFields, audience: PricingAudience): number | null {
  const v = audience === 'B2B' ? row.price3yB2b : row.price3yB2c
  return v == null ? null : v
}

export function describePricingForPrompt(opts: ProposalPricingOptions): string {
  const aud = opts.audience === 'B2B' ? 'B2B' : 'B2C'
  const parts: string[] = []
  if (opts.commitment.oneYear) parts.push('**1-year** commitment (yearly list)')
  if (opts.commitment.threeYear) parts.push('**3-year** commitment (total for three years per catalog row)')
  return `**Pricing audience:** ${aud}. **Quote:** ${parts.join(' and ') || '(none — invalid)'}.`
}
