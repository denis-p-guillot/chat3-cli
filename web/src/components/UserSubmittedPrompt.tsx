import { useMemo, useState, type ReactNode } from 'react'

export type UserSubmissionSource = 'manual' | 'automation'

const COLLAPSED_LINE_COUNT = 10

/** Best-effort label for messages saved before `submission` existed. */
export function inferUserSubmission(content: string, explicit?: UserSubmissionSource): UserSubmissionSource {
  if (explicit) return explicit
  const c = content.trimStart()
  if (c.startsWith('[PurpleCloud Proposal]')) return 'automation'
  if (c.includes('[Diagnose Error Run Stages]')) return 'automation'
  return 'manual'
}

function IconManual({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"
      />
    </svg>
  )
}

function IconAutomation({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.847a4.5 4.5 0 003.09 3.09L15.75 12l-2.847.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z"
      />
    </svg>
  )
}

type UserSubmittedPromptProps = {
  content: string
  submission?: UserSubmissionSource
  /** Rendered below the source badge (e.g. attachment list). */
  children?: ReactNode
}

export function UserSubmittedPrompt({ content, submission, children }: UserSubmittedPromptProps) {
  const [expanded, setExpanded] = useState(false)
  const source = useMemo(() => inferUserSubmission(content, submission), [content, submission])

  const hasText = content.trim().length > 0
  const lines = hasText ? content.split(/\r?\n/) : []
  const isLong = lines.length > COLLAPSED_LINE_COUNT
  const displayText = isLong && !expanded ? lines.slice(0, COLLAPSED_LINE_COUNT).join('\n') : content

  const label = source === 'automation' ? 'Submitted by automation' : 'Manual input or update'
  const shortLabel = source === 'automation' ? 'Automation' : 'Manual'

  return (
    <div className="user-submitted-prompt">
      <div
        className={`user-submitted-prompt-source user-submitted-prompt-source--${source}`}
        title={label}
        aria-label={label}
      >
        {source === 'automation' ? <IconAutomation /> : <IconManual />}
        <span>{shortLabel}</span>
      </div>
      {children}
      {hasText ? (
        <>
          <p className="user-text">{displayText}</p>
          {isLong && (
            <button
              type="button"
              className="user-submitted-prompt-toggle"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
            >
              {expanded ? 'Show fewer lines' : `Show all (${lines.length} lines)`}
            </button>
          )}
        </>
      ) : !children ? (
        <p className="user-text muted">(empty prompt)</p>
      ) : (
        <p className="user-text muted">(no message text — attachments only)</p>
      )}
    </div>
  )
}
