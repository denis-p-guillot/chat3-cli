export const APP_VERSION = '0.6'

const POLL_MS = 30_000

let currentAgentId: string | null = null
let started = false

type VersionPayload = {
  agent_id?: string
  app_version?: string
  build_id?: string
  server_boot_id?: string
}

async function fetchAgentId(): Promise<string | null> {
  const res = await fetch('/api/version', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  const data = (await res.json()) as VersionPayload
  return typeof data.agent_id === 'string' && data.agent_id.length > 0 ? data.agent_id : null
}

async function checkForAppUpdate(forceReload = false) {
  const agentId = await fetchAgentId()
  if (!agentId) return

  if (currentAgentId === null) {
    currentAgentId = agentId
    return
  }

  if (agentId !== currentAgentId || forceReload) {
    window.location.reload()
  }
}

/** Poll the server and reload automatically when a newer agent build is deployed. */
export function startAppVersionWatcher() {
  if (started || typeof window === 'undefined') return
  started = true

  void checkForAppUpdate()

  window.setInterval(() => {
    void checkForAppUpdate()
  }, POLL_MS)

  window.addEventListener('focus', () => {
    void checkForAppUpdate()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void checkForAppUpdate()
    }
  })
}
