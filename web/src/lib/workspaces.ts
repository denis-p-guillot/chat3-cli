export type WorkspaceSummary = { id: number; name: string; created_at: string }

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

export async function fetchWorkspacesList(): Promise<{ workspaces: WorkspaceSummary[]; active_id: number | null }> {
  const res = await fetch('/api/workspaces', { credentials: 'include' })
  if (!res.ok) throw new Error(await parseErr(res))
  return res.json() as Promise<{ workspaces: WorkspaceSummary[]; active_id: number | null }>
}

export async function createWorkspace(name: string): Promise<{ id: number; name: string }> {
  const res = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(await parseErr(res))
  return res.json() as Promise<{ id: number; name: string }>
}

export async function activateWorkspace(workspaceId: number): Promise<void> {
  const res = await fetch(`/api/workspaces/${workspaceId}/activate`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await parseErr(res))
}
