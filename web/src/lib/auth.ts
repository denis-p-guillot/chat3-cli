export type Me = {
  id: number
  username: string
  display_name: string
  has_openai_key: boolean
  active_workspace_id: number
  active_workspace_name: string
}

export type Settings = {
  display_name: string
  has_openai_key: boolean
  llm_model: string
  available_models: string[]
  odoo_url: string
  odoo_login: string
  odoo_db: string
  odoo_auth_mode: string
  has_odoo_password: boolean
}

async function parseError(res: Response): Promise<string> {
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

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' })
  if (res.status === 401) return null
  if (!res.ok) throw new Error(await parseError(res))
  return res.json() as Promise<Me>
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(await parseError(res))
}

export async function register(username: string, password: string, displayName = ''): Promise<void> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password, display_name: displayName }),
  })
  if (!res.ok) throw new Error(await parseError(res))
}

export async function logout(): Promise<void> {
  const res = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  if (!res.ok) throw new Error(await parseError(res))
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch('/api/auth/settings', { credentials: 'include' })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json() as Promise<Settings>
}

export async function putSettings(body: {
  display_name?: string
  openai_api_key?: string
  llm_model?: string
  odoo_url?: string
  odoo_login?: string
  odoo_password?: string
  odoo_db?: string
}): Promise<Settings> {
  const res = await fetch('/api/auth/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json() as Promise<Settings>
}

export async function startOdooSso(body: { odoo_url?: string; odoo_db?: string } = {}): Promise<{
  authorize_url: string
  state: string
}> {
  const res = await fetch('/api/odoo/sso/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json() as Promise<{ authorize_url: string; state: string }>
}
