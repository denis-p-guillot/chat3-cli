import { analyzePasswordStrength, type PasswordStrengthResult } from './lib/passwordStrength'

type Props = {
  password: string
}

export function PasswordStrengthMeter({ password }: Props) {
  const s: PasswordStrengthResult = analyzePasswordStrength(password)
  const segments = 4
  const active = s.score

  return (
    <div className={`pw-strength pw-score-${active}`} aria-live="polite">
      <div className="pw-strength-head">
        <span className="pw-strength-label">Password strength</span>
        {s.label ? <span className="pw-strength-badge">{s.label}</span> : null}
      </div>
      <div
        className="pw-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={active}
        aria-label="Password strength"
      >
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={`pw-meter-seg ${i < active ? 'filled' : ''}`} />
        ))}
      </div>
      {s.hint ? <p className="pw-strength-hint">{s.hint}</p> : null}
      <ul className="pw-checklist">
        {s.checks.map((c) => (
          <li key={c.id} className={c.ok ? 'ok' : ''}>
            <span className="pw-check-icon" aria-hidden>
              {c.ok ? '✓' : '○'}
            </span>
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
