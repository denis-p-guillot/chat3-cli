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
): Promise<{ status: string; path: string; name: string }> {
  const res = await fetch('/api/tools/diagnose-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ context, ssh_connections: sshConnections }),
  })
  if (!res.ok) throw new Error(await parseErr(res))
  return (await res.json()) as { status: string; path: string; name: string }
}
