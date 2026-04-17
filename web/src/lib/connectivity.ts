export type SshConnection = {
  id: number
  name: string
  host: string
  port: number
  username: string
  auth_mode: 'private_key' | 'password' | 'private_key_password'
  has_private_key: boolean
  has_password: boolean
  created_at: string
  updated_at: string
}

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

export async function listSshConnections(): Promise<SshConnection[]> {
  const res = await fetch('/api/connectivity/ssh', { credentials: 'include' })
  if (!res.ok) throw new Error(await parseErr(res))
  const data = (await res.json()) as { connections: SshConnection[] }
  return data.connections
}

export async function saveSshConnection(body: {
  name: string
  host: string
  port: number
  username: string
  auth_mode: 'private_key' | 'password' | 'private_key_password'
  private_key?: string
  password?: string
}): Promise<SshConnection> {
  const res = await fetch('/api/connectivity/ssh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await parseErr(res))
  const data = (await res.json()) as { connection: SshConnection }
  return data.connection
}

export async function deleteSshConnection(connectionId: number): Promise<void> {
  const res = await fetch(`/api/connectivity/ssh/${connectionId}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await parseErr(res))
}

export async function testSshConnection(connectionId: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await fetch(`/api/connectivity/ssh/${connectionId}/test`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) throw new Error(await parseErr(res))
  return (await res.json()) as { ok: boolean; stdout: string; stderr: string }
}
