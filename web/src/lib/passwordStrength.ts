export type PasswordStrengthResult = {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  hint: string
  checks: { id: string; text: string; ok: boolean }[]
}

/** Heuristic score + checklist for registration UX (bcrypt allows 72 UTF-8 bytes server-side). */
export function analyzePasswordStrength(password: string): PasswordStrengthResult {
  const len = password.length
  const hasLower = /[a-z]/.test(password)
  const hasUpper = /[A-Z]/.test(password)
  const hasDigit = /\d/.test(password)
  const hasSymbol = /[^A-Za-z0-9]/.test(password)

  const checks = [
    { id: 'len8', text: 'At least 8 characters', ok: len >= 8 },
    { id: 'len12', text: '12+ characters (stronger passphrase)', ok: len >= 12 },
    { id: 'mixed', text: 'Uppercase and lowercase letters', ok: hasLower && hasUpper },
    { id: 'digit', text: 'At least one number', ok: hasDigit },
    { id: 'symbol', text: 'At least one symbol (!@#$…)', ok: hasSymbol },
  ]

  if (len === 0) {
    return {
      score: 0,
      label: '',
      hint: 'Choose a password you do not use elsewhere.',
      checks,
    }
  }
  if (len < 8) {
    return {
      score: 0,
      label: 'Too short',
      hint: 'Use at least 8 characters. Longer passphrases with mixed characters are stronger.',
      checks,
    }
  }

  const met = checks.filter((c) => c.ok).length
  let score: 1 | 2 | 3 | 4 = 1
  if (met <= 2) score = 1
  else if (met === 3) score = 2
  else if (met === 4) score = 3
  else score = 4

  const labels: Record<1 | 2 | 3 | 4, string> = {
    1: 'Weak',
    2: 'Fair',
    3: 'Good',
    4: 'Strong',
  }
  const hints: Record<1 | 2 | 3 | 4, string> = {
    1: 'Add length, mixed case, numbers, and symbols to strengthen your password.',
    2: 'You are on the right track — tick more boxes below.',
    3: 'Solid password. Consider a few more characters for extra safety.',
    4: 'Excellent — this meets common strength guidelines.',
  }

  return {
    score,
    label: labels[score],
    hint: hints[score],
    checks,
  }
}
