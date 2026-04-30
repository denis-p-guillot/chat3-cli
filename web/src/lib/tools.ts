async function parseErr(res: Response): Promise<string> {
  let detail = res.statusText
  try {
    const j: { detail?: unknown } = await res.json()
    if (typeof j.detail === 'string') detail = j.detail
    else if (j.detail != null) detail = JSON.stringify(j.detail)
  } catch {
    try {
      detail = await res.text()
    } catch {
      /* ignore */
    }
  }
  return detail || `HTTP ${res.status}`
}

export async function runDiagnoseError(
  context: string,
  sshConnections: string[],
): Promise<{ status: string; path: string; name: string; activity?: string[]; ssh_connections?: Array<Record<string, unknown>> }> {
  const res = await fetch('/api/tools/diagnose-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ context, ssh_connections: sshConnections }),
  })
  if (!res.ok) throw new Error(await parseErr(res))
  return (await res.json()) as {
    status: string
    path: string
    name: string
    activity?: string[]
    ssh_connections?: Array<Record<string, unknown>>
  }
}

type DiagnoseStreamEvent =
  | { type: 'activity'; step: string }
  | {
      type: 'result'
      result: {
        status: string
        path?: string
        name?: string
        activity?: string[]
        ssh_connections?: Array<Record<string, unknown>>
      }
    }
  | { type: 'error'; message: string }
  | { type: 'done' }

export async function runDiagnoseErrorStream(
  context: string,
  sshConnections: string[],
  handlers: {
    onActivity?: (step: string) => void
    onResult?: (result: {
      status: string
      path?: string
      name?: string
      activity?: string[]
      ssh_connections?: Array<Record<string, unknown>>
    }) => void
  } = {},
): Promise<{
  status: string
  path?: string
  name?: string
  activity?: string[]
  ssh_connections?: Array<Record<string, unknown>>
}> {
  const res = await fetch('/api/tools/diagnose-error/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ context, ssh_connections: sshConnections, generate_report: false }),
  })
  if (!res.ok) throw new Error(await parseErr(res))
  if (!res.body) throw new Error('No stream response body.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalResult:
    | {
        status: string
        path?: string
        name?: string
        activity?: string[]
        ssh_connections?: Array<Record<string, unknown>>
      }
    | null = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let split = buf.indexOf('\n\n')
    while (split >= 0) {
      const rawEvent = buf.slice(0, split)
      buf = buf.slice(split + 2)
      split = buf.indexOf('\n\n')
      const lines = rawEvent.split('\n')
      for (const ln of lines) {
        if (!ln.startsWith('data: ')) continue
        const payload = ln.slice(6).trim()
        if (!payload) continue
        let ev: DiagnoseStreamEvent
        try {
          ev = JSON.parse(payload) as DiagnoseStreamEvent
        } catch {
          continue
        }
        if (ev.type === 'activity') {
          handlers.onActivity?.(ev.step)
        } else if (ev.type === 'result') {
          finalResult = ev.result
          handlers.onResult?.(ev.result)
        } else if (ev.type === 'error') {
          throw new Error(ev.message || 'Diagnose stream failed.')
        }
      }
    }
  }

  if (!finalResult) throw new Error('Diagnose stream ended without final result.')
  return finalResult
}

export async function renderDiagnoseHtmlReport(
  context?: string,
  sshConnectionsData?: Array<Record<string, unknown>>,
  activity?: string[],
  assistantSummary?: string,
): Promise<{ status: string; path: string; name: string; activity?: string[] }> {
  const res = await fetch('/api/tools/diagnose-error/render-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      context: context ?? '',
      ssh_connections_data: sshConnectionsData ?? [],
      activity: activity ?? [],
      assistant_summary: assistantSummary ?? '',
    }),
  })
  if (!res.ok) throw new Error(await parseErr(res))
  return (await res.json()) as { status: string; path: string; name: string; activity?: string[] }
}
