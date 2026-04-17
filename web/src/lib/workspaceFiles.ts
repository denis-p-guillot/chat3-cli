export type WorkspaceEntry = {
  path: string
  type: 'file' | 'dir'
  size?: number
}

async function parseErr(res: Response): Promise<string> {
  let detail = res.statusText
  try {
    const j: { detail?: unknown } = await res.json()
    if (typeof j.detail === 'string') detail = j.detail
    else if (Array.isArray(j.detail)) detail = JSON.stringify(j.detail)
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

export async function fetchWorkspaceFiles(): Promise<{
  root: string
  entries: WorkspaceEntry[]
  truncated: boolean
}> {
  const res = await fetch('/api/workspace/files', { credentials: 'include' })
  if (!res.ok) throw new Error(await parseErr(res))
  return res.json() as Promise<{ root: string; entries: WorkspaceEntry[]; truncated: boolean }>
}
