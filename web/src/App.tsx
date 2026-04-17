import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
  uploadWorkspaceFiles,
  type UploadedWorkspaceFile,
} from './lib/attachments'
import {
  fetchMe,
  getSettings,
  login,
  logout,
  putSettings,
  register,
  type Me,
  type Settings,
} from './lib/auth'
import {
  deserializeChatMessages,
  fetchChatHistory,
  saveChatHistory,
  serializeChatMessages,
} from './lib/chatStorage'
import { isAbortError, streamChat, type ChatMessagePayload } from './lib/streamChat'
import { PasswordStrengthMeter } from './PasswordStrengthMeter'
import {
  activateWorkspace,
  createWorkspace,
  fetchWorkspacesList,
  type WorkspaceSummary,
} from './lib/workspaces'
import { fetchWorkspaceFiles, type WorkspaceEntry } from './lib/workspaceFiles'
import {
  deleteSshConnection,
  listSshConnections,
  saveSshConnection,
  testSshConnection,
  type SshConnection,
} from './lib/connectivity'
import { runDiagnoseError } from './lib/tools'
import './App.css'

const WORKSPACE_PATH_DRAG_TYPE = 'application/x-purplecloud-workspace-path'
const SSH_CONNECTION_DRAG_TYPE = 'application/x-purplecloud-ssh-connection'

type ToolRow = {
  name: string
  args: Record<string, unknown>
  output?: string
}

type UserMsg = {
  id: string
  role: 'user'
  /** Text shown in the bubble */
  content: string
  /** Relative paths under workspace (persisted for API history) */
  workspaceFiles?: string[]
  attachmentSummary?: { name: string; size: number; path: string }[]
}

type ChatMsg =
  | UserMsg
  | { id: string; role: 'assistant'; content: string }
  | { id: string; role: 'tool'; name: string; args: Record<string, unknown>; output: string }

type Meta = {
  model: string
  workspace: string
  base_dir: string
  user_workspace?: string
  user_workspace_abs?: string
  active_workspace_id?: string
  active_workspace_name?: string
}

function uid() {
  return crypto.randomUUID()
}

function IconSettings({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.228-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.228.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.213-1.281z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}

function IconLogout({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"
      />
    </svg>
  )
}

function IconAttach({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-8.49 8.49a5 5 0 11-7.07-7.07l9.19-9.19a3.5 3.5 0 114.95 4.95L10.48 17.8a2 2 0 11-2.83-2.83l7.78-7.78" />
    </svg>
  )
}

function IconRetry({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 11a8 8 0 10-2.34 5.66" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 4v7h-7" />
    </svg>
  )
}

function IconSend({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  )
}

function IconStop({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
    </svg>
  )
}

function IconToolbox({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.5h18v10A2.5 2.5 0 0118.5 21h-13A2.5 2.5 0 013 18.5v-10z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 8.5V6.8A1.8 1.8 0 0110.8 5h2.4A1.8 1.8 0 0115 6.8v1.7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12.5h18" />
    </svg>
  )
}

function buildApiPayload(messages: ChatMsg[]): ChatMessagePayload[] {
  const out: ChatMessagePayload[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const u = m as UserMsg
      const row: ChatMessagePayload = { role: 'user', content: u.content }
      if (u.workspaceFiles?.length) {
        row.workspace_files = u.workspaceFiles
      }
      out.push(row)
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

/** True when the last turn can be re-run (failed, stopped, or incomplete). */
function canRetryFromMessages(msgs: ChatMsg[]): boolean {
  if (msgs.length === 0) return false
  const last = msgs[msgs.length - 1]
  if (last.role === 'assistant') {
    const c = last.content
    return c.startsWith('**Error:**') || c.includes('_(stopped)_')
  }
  if (last.role === 'user') return true
  if (last.role === 'tool') return true
  return false
}

function AuthPanel({ onLoggedIn }: { onLoggedIn: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      if (mode === 'login') await login(username, password)
      else await register(username, password, displayName)
      const u = await fetchMe()
      if (u) onLoggedIn(u)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden />
          <div className="brand-lockup">
            <span className="brand-product">PurpleCloud</span>
            <h1 className="brand-title">Brain AI</h1>
          </div>
        </div>
        <p className="auth-tagline">Sign in to your PurpleCloud workspace</p>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => {
              setMode('login')
              setErr(null)
            }}
          >
            Log in
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => {
              setMode('register')
              setErr(null)
            }}
          >
            Register
          </button>
        </div>
        <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
          <label>
            Username or email
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={3}
              maxLength={254}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              maxLength={128}
            />
          </label>
          {mode === 'register' && <PasswordStrengthMeter password={password} />}
          {mode === 'register' && (
            <label>
              Display name <span className="optional">(optional)</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
          )}
          {err && <p className="warn">{err}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  )
}

function SettingsModal({
  me,
  onClose,
  onSaved,
}: {
  me: Me
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [displayName, setDisplayName] = useState(me.display_name)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void getSettings().then((s) => {
      setDisplayName(s.display_name)
    })
    setApiKey('')
    setErr(null)
  }, [me.id])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      const body: { display_name: string; openai_api_key?: string } = { display_name: displayName }
      if (apiKey.trim()) body.openai_api_key = apiKey.trim()
      const s = await putSettings(body)
      onSaved(s)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function clearKey() {
    setErr(null)
    setBusy(true)
    try {
      const s = await putSettings({ openai_api_key: '' })
      setApiKey('')
      onSaved(s)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Settings</h2>
        <form className="auth-form" onSubmit={(e) => void save(e)}>
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label>
            OpenAI API key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={me.has_openai_key ? 'Leave blank to keep current key' : 'sk-…'}
              autoComplete="off"
            />
          </label>
          {err && <p className="warn">{err}</p>}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn secondary" onClick={() => void clearKey()} disabled={busy || !me.has_openai_key}>
              Remove key
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ChatSession({
  me,
  onMeChange,
  onLogout,
  onMeRefresh,
}: {
  me: Me
  onMeChange: (patch: Partial<Me>) => void
  onLogout: () => void | Promise<void>
  onMeRefresh: () => Promise<void>
}) {
  const STREAM_STALL_TIMEOUT_MS = 130_000
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const streamRef = useRef<{ tools: ToolRow[]; assistant?: string; error?: string }>({
    tools: [],
  })
  const abortRef = useRef<AbortController | null>(null)
  const abortReasonRef = useRef<'user' | 'timeout' | null>(null)
  const lastStreamEventAtRef = useRef<number>(0)
  const threadRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [historyHydrated, setHistoryHydrated] = useState(false)
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([])
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([])
  const [workspaceFilesBusy, setWorkspaceFilesBusy] = useState(false)
  const [workspaceFilesErr, setWorkspaceFilesErr] = useState<string | null>(null)
  const [workspaceFilesTruncated, setWorkspaceFilesTruncated] = useState(false)
  const [workspaceFilesOpen, setWorkspaceFilesOpen] = useState(false)
  const [workspaceSearch, setWorkspaceSearch] = useState('')
  const [pendingWorkspacePaths, setPendingWorkspacePaths] = useState<string[]>([])
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([])
  const [sshBusy, setSshBusy] = useState(false)
  const [sshErr, setSshErr] = useState<string | null>(null)
  const [sshForm, setSshForm] = useState({
    name: '',
    host: '',
    port: 22,
    username: '',
    auth_mode: 'private_key' as 'private_key' | 'password' | 'private_key_password',
    private_key: '',
    password: '',
  })
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [diagnoseBusy, setDiagnoseBusy] = useState(false)
  const [diagnoseErr, setDiagnoseErr] = useState<string | null>(null)
  const [diagnoseContext, setDiagnoseContext] = useState('')
  const [diagnoseSshConnections, setDiagnoseSshConnections] = useState<string[]>([])
  const [toolboxDragOver, setToolboxDragOver] = useState(false)

  useEffect(() => {
    fetch('/api/meta', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((m: Meta) => setMeta(m))
      .catch((e: Error) => setMetaErr(e.message))
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    void fetchWorkspacesList()
      .then((d) => setWorkspaceList(d.workspaces))
      .catch(() => setWorkspaceList([]))
  }, [me.id, me.active_workspace_id])

  const refreshSshConnections = async () => {
    setSshBusy(true)
    setSshErr(null)
    try {
      setSshConnections(await listSshConnections())
    } catch (e) {
      setSshErr(e instanceof Error ? e.message : String(e))
      setSshConnections([])
    } finally {
      setSshBusy(false)
    }
  }

  useEffect(() => {
    void refreshSshConnections()
  }, [me.id])

  const refreshWorkspaceFiles = async () => {
    setWorkspaceFilesBusy(true)
    setWorkspaceFilesErr(null)
    try {
      const data = await fetchWorkspaceFiles()
      setWorkspaceEntries(data.entries)
      setWorkspaceFilesTruncated(data.truncated)
    } catch (e) {
      setWorkspaceEntries([])
      setWorkspaceFilesTruncated(false)
      setWorkspaceFilesErr(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkspaceFilesBusy(false)
    }
  }

  useEffect(() => {
    void refreshWorkspaceFiles()
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    setPendingWorkspacePaths([])
    setWorkspaceSearch('')
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    setHistoryHydrated(false)
    let cancelled = false
    void fetchChatHistory()
      .then((raw) => {
        if (cancelled) return
        const next = deserializeChatMessages(raw) as ChatMsg[]
        setMessages(next)
      })
      .catch(() => {
        /* keep empty if unreadable */
      })
      .finally(() => {
        if (!cancelled) setHistoryHydrated(true)
      })
    return () => {
      cancelled = true
    }
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    if (!historyHydrated) return
    const t = window.setTimeout(() => {
      void saveChatHistory(serializeChatMessages(messages)).catch(() => {})
    }, 650)
    return () => window.clearTimeout(t)
  }, [messages, historyHydrated, me.id, me.active_workspace_id])

  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    const id = requestAnimationFrame(() => {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: busy ? 'auto' : 'smooth',
      })
    })
    return () => cancelAnimationFrame(id)
  }, [messages, busy, tick])

  const runStream = async (payload: ChatMessagePayload[]) => {
    const ac = new AbortController()
    abortRef.current = ac
    abortReasonRef.current = null
    lastStreamEventAtRef.current = Date.now()
    setBusy(true)
    streamRef.current = { tools: [] }
    try {
      await streamChat(
        payload,
        (ev) => {
          const s = streamRef.current
          if (ev.type === 'tool_call') {
            s.tools.push({ name: ev.name, args: ev.arguments, output: undefined })
          } else if (ev.type === 'tool_result') {
            for (let i = s.tools.length - 1; i >= 0; i--) {
              if (s.tools[i].name === ev.name && s.tools[i].output === undefined) {
                s.tools[i] = { ...s.tools[i], output: ev.output }
                break
              }
            }
          } else if (ev.type === 'assistant') {
            s.assistant = ev.content
          } else if (ev.type === 'error') {
            s.error = ev.message
          }
          lastStreamEventAtRef.current = Date.now()
          setTick((x) => x + 1)
        },
        { signal: ac.signal },
      )

      const fin = streamRef.current
      streamRef.current = { tools: [] }
      setTick((x) => x + 1)
      setMessages((prev) => {
        const next = [...prev]
        for (const t of fin.tools) {
          next.push({
            id: uid(),
            role: 'tool',
            name: t.name,
            args: t.args,
            output: t.output ?? '',
          })
        }
        if (fin.assistant) {
          next.push({ id: uid(), role: 'assistant', content: fin.assistant })
        }
        if (fin.error) {
          next.push({ id: uid(), role: 'assistant', content: `**Error:** ${fin.error}` })
        }
        return next
      })
    } catch (e) {
      if (isAbortError(e)) {
        const abortReason = abortReasonRef.current
        const fin = streamRef.current
        streamRef.current = { tools: [] }
        setTick((x) => x + 1)
        setMessages((prev) => {
          const next = [...prev]
          for (const t of fin.tools) {
            next.push({
              id: uid(),
              role: 'tool',
              name: t.name,
              args: t.args,
              output: t.output ?? '',
            })
          }
          if (abortReason === 'timeout') {
            next.push({
              id: uid(),
              role: 'assistant',
              content:
                '**Error:** Request timed out while waiting for the model response.\n\nYou can click **Retry** or send a shorter request.',
            })
          } else if (fin.error) {
            next.push({
              id: uid(),
              role: 'assistant',
              content: `**Error:** ${fin.error}\n\n_(stopped)_`,
            })
          } else if (fin.assistant) {
            next.push({
              id: uid(),
              role: 'assistant',
              content: `${fin.assistant}\n\n_(stopped)_`,
            })
          } else {
            next.push({ id: uid(), role: 'assistant', content: '_(stopped)_' })
          }
          return next
        })
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `**Error:** ${msg}` }])
      }
    } finally {
      setBusy(false)
      abortRef.current = null
      abortReasonRef.current = null
      streamRef.current = { tools: [] }
      setTick((x) => x + 1)
    }
  }

  const send = async () => {
    if (!historyHydrated) return
    const text = input.trim()
    const files = pendingFiles
    const linkedPaths = pendingWorkspacePaths
    if ((!text && files.length === 0 && linkedPaths.length === 0) || busy) return

    if (files.length > MAX_ATTACHMENTS) {
      alert(`You can attach at most ${MAX_ATTACHMENTS} files.`)
      return
    }
    let total = 0
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        alert(`"${f.name}" is too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB per file).`)
        return
      }
      total += f.size
    }
    if (total > MAX_TOTAL_UPLOAD_BYTES) {
      alert(`Total upload size is too large (max ${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)} MB per request).`)
      return
    }

    let uploaded: UploadedWorkspaceFile[] = []
    if (files.length > 0) {
      try {
        uploaded = await uploadWorkspaceFiles(files)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `**Error:** ${msg}` }])
        return
      }
    }

    const userId = uid()
    const workspacePaths = [...new Set([...linkedPaths, ...uploaded.map((u) => u.path)])]
    const uploadedByPath = new Map(uploaded.map((u) => [u.path, u]))
    const attachmentSummary: { name: string; size: number; path: string }[] = workspacePaths.map((path) => {
      const up = uploadedByPath.get(path)
      if (up) {
        return { name: up.name, size: up.size, path }
      }
      const entry = workspaceEntries.find((x) => x.type === 'file' && x.path === path)
      return {
        name: path.split('/').pop() || path,
        size: entry?.size ?? 0,
        path,
      }
    })

    const payload: ChatMessagePayload[] = [
      ...buildApiPayload(messages),
      workspacePaths.length
        ? { role: 'user', content: text, workspace_files: workspacePaths }
        : { role: 'user', content: text },
    ]

    setInput('')
    setPendingFiles([])
    setPendingWorkspacePaths([])
    setMessages((m) => [
      ...m,
      {
        id: userId,
        role: 'user',
        content: text,
        workspaceFiles: workspacePaths.length ? workspacePaths : undefined,
        attachmentSummary: attachmentSummary.length ? attachmentSummary : undefined,
      },
    ])
    if (workspacePaths.length > 0) {
      void refreshWorkspaceFiles()
    }

    await runStream(payload)
  }

  const stop = () => {
    abortReasonRef.current = 'user'
    abortRef.current?.abort()
  }

  useEffect(() => {
    if (!busy) return
    const id = window.setInterval(() => {
      const last = lastStreamEventAtRef.current || 0
      if (!last) return
      if (Date.now() - last < STREAM_STALL_TIMEOUT_MS) return
      if (abortRef.current) {
        abortReasonRef.current = 'timeout'
        abortRef.current.abort()
      }
    }, 2000)
    return () => window.clearInterval(id)
  }, [busy])

  const retry = () => {
    if (busy || !historyHydrated || !canRetryFromMessages(messages)) return
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) return
    const trimmed = messages.slice(0, lastUserIdx + 1)
    setMessages(trimmed)
    void runStream(buildApiPayload(trimmed))
  }

  const clear = () => {
    if (busy) return
    setMessages([])
    setPendingFiles([])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const mergeFilesIntoPending = (list: FileList | File[]) => {
    const arr = Array.from(list)
    if (!arr.length) return
    setPendingFiles((prev) => {
      const next = [...prev]
      for (const f of arr) {
        if (next.length >= MAX_ATTACHMENTS) break
        next.push(f)
      }
      return next
    })
  }

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list?.length) return
    mergeFilesIntoPending(list)
    e.target.value = ''
  }

  const onDropFiles = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const droppedWorkspacePath = e.dataTransfer.getData(WORKSPACE_PATH_DRAG_TYPE)
    if (droppedWorkspacePath) {
      setPendingWorkspacePaths((prev) => (prev.includes(droppedWorkspacePath) ? prev : [...prev, droppedWorkspacePath]))
      return
    }
    if (e.dataTransfer.files?.length) mergeFilesIntoPending(e.dataTransfer.files)
  }

  const removePending = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const removePendingWorkspacePath = (path: string) => {
    setPendingWorkspacePaths((prev) => prev.filter((p) => p !== path))
  }

  const addPendingWorkspacePath = (path: string) => {
    setPendingWorkspacePaths((prev) => (prev.includes(path) ? prev : [...prev, path]))
  }

  const switchWorkspace = async (id: number) => {
    if (id === me.active_workspace_id || workspaceBusy) return
    setWorkspaceBusy(true)
    try {
      await activateWorkspace(id)
      await onMeRefresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const addWorkspace = async () => {
    const name = window.prompt('Name for the new workspace')
    if (name == null) return
    const trimmed = name.trim()
    if (!trimmed) return
    setWorkspaceBusy(true)
    try {
      const { id } = await createWorkspace(trimmed)
      await activateWorkspace(id)
      await onMeRefresh()
      const d = await fetchWorkspacesList()
      setWorkspaceList(d.workspaces)
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const submitSsh = async (e: React.FormEvent) => {
    e.preventDefault()
    setSshErr(null)
    setSshBusy(true)
    try {
      await saveSshConnection({
        name: sshForm.name.trim(),
        host: sshForm.host.trim(),
        port: Number(sshForm.port) || 22,
        username: sshForm.username.trim(),
        auth_mode: sshForm.auth_mode,
        private_key: sshForm.private_key,
        password: sshForm.password,
      })
      setSshForm((x) => ({ ...x, private_key: '', password: '' }))
      await refreshSshConnections()
    } catch (err) {
      setSshErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSshBusy(false)
    }
  }

  const removeSsh = async (id: number) => {
    if (busy) return
    try {
      await deleteSshConnection(id)
      await refreshSshConnections()
    } catch (err) {
      setSshErr(err instanceof Error ? err.message : String(err))
    }
  }

  const testSsh = async (id: number) => {
    setSshErr(null)
    setSshBusy(true)
    try {
      const res = await testSshConnection(id)
      if (res.ok) {
        alert(`SSH test successful.\n${res.stdout || '(no output)'}`)
      } else {
        alert(`SSH test failed.\n${res.stderr || '(no error output)'}`)
      }
    } catch (err) {
      setSshErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSshBusy(false)
    }
  }

  const diagnoseError = async () => {
    setDiagnoseErr(null)
    setDiagnoseBusy(true)
    try {
      const out = await runDiagnoseError(diagnoseContext, diagnoseSshConnections)
      addPendingWorkspacePath(out.path)
      await refreshWorkspaceFiles()
      setToolboxOpen(false)
      setDiagnoseContext('')
      setDiagnoseSshConnections([])
      alert(`Report generated: ${out.name}\nLinked to your next prompt as ${out.path}`)
    } catch (err) {
      setDiagnoseErr(err instanceof Error ? err.message : String(err))
    } finally {
      setDiagnoseBusy(false)
    }
  }

  const addDiagnoseSshConnection = (name: string) => {
    const clean = name.trim()
    if (!clean) return
    setDiagnoseSshConnections((prev) => (prev.includes(clean) ? prev : [...prev, clean]))
  }

  const removeDiagnoseSshConnection = (name: string) => {
    setDiagnoseSshConnections((prev) => prev.filter((x) => x !== name))
  }

  const live = busy ? streamRef.current : null
  const execStatusText = (() => {
    if (!busy) return ''
    const lv = streamRef.current
    if (lv.tools.some((t) => t.output === undefined)) return 'Running tools…'
    const assistantText = lv.assistant ?? ''
    if (assistantText.length > 0) return 'Generating reply…'
    // Tools finished: backend is in another OpenAI round (or final call) with no SSE until it returns.
    if (lv.tools.length > 0) return 'Calling model…'
    return 'Thinking…'
  })()
  const filteredWorkspaceEntries = workspaceEntries.filter((entry) => {
    if (!workspaceSearch.trim()) return true
    return entry.path.toLowerCase().includes(workspaceSearch.trim().toLowerCase())
  })
  const canSend =
    historyHydrated && !busy && (input.trim().length > 0 || pendingFiles.length > 0 || pendingWorkspacePaths.length > 0)
  const canRetry = historyHydrated && !busy && canRetryFromMessages(messages)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-left">
            <span className="brand-mark" aria-hidden />
            <div className="brand-lockup">
              <span className="brand-product">PurpleCloud</span>
              <h1 className="brand-title">Brain AI</h1>
              <p className="tagline">Version 0.6</p>
            </div>
          </div>
          <div className="brand-toolbar" role="toolbar" aria-label="Account actions">
            <button
              type="button"
              className={`icon-btn ${toolboxOpen ? 'icon-btn-active' : ''}`}
              onClick={() => {
                setToolboxOpen((v) => !v)
                setDiagnoseErr(null)
                setToolboxDragOver(false)
              }}
              title="Toolbox"
              aria-label="Toolbox"
            >
              <IconToolbox />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings — API key and profile"
              aria-label="Settings"
            >
              <IconSettings />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-logout"
              onClick={() => {
                void onLogout()
              }}
              title="Log out"
              aria-label="Log out"
            >
              <IconLogout />
            </button>
          </div>
        </div>

        {toolboxOpen && (
          <div className="sidebar-section sidebar-widget">
            <h2>Toolbox</h2>
            <div
              className={`toolbox-item ${toolboxDragOver ? 'toolbox-drop' : ''}`}
              onDragEnter={(e) => {
                const hasSsh = Array.from(e.dataTransfer.types).includes(SSH_CONNECTION_DRAG_TYPE)
                if (!hasSsh) return
                e.preventDefault()
                setToolboxDragOver(true)
              }}
              onDragOver={(e) => {
                const hasSsh = Array.from(e.dataTransfer.types).includes(SSH_CONNECTION_DRAG_TYPE)
                if (!hasSsh) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                setToolboxDragOver(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setToolboxDragOver(false)
                const name = e.dataTransfer.getData(SSH_CONNECTION_DRAG_TYPE)
                if (name) addDiagnoseSshConnection(name)
              }}
            >
              <h3>Diagnose Error</h3>
              <p className="muted toolbox-help">
                Generates <code>issue_analysis.html</code> in the active workspace and links it to your next prompt.
              </p>
              <p className="muted toolbox-help">
                Drag SSH connections from the Connectivity widget here to grant diagnosis SSH scope.
              </p>
              {diagnoseSshConnections.length > 0 && (
                <ul className="toolbox-ssh-list">
                  {diagnoseSshConnections.map((name) => (
                    <li key={name}>
                      <span>{name}</span>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => removeDiagnoseSshConnection(name)}
                        aria-label={`Remove SSH connection ${name}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                className="toolbox-textarea"
                placeholder="Paste logs, traceback, or incident context..."
                value={diagnoseContext}
                onChange={(e) => setDiagnoseContext(e.target.value)}
                rows={5}
              />
              {diagnoseErr && <p className="warn">{diagnoseErr}</p>}
              <button type="button" className="btn secondary" onClick={() => void diagnoseError()} disabled={diagnoseBusy}>
                {diagnoseBusy ? 'Generating…' : 'Run Diagnose Error'}
              </button>
            </div>
          </div>
        )}

        <div className="sidebar-section">
          <h2>Account</h2>
          <p className="account-name">{me.display_name}</p>
          <p className="account-user muted" title={me.username}>
            {me.username.includes('@') ? me.username : `@${me.username}`}
          </p>
          <label className="workspace-label">
            Workspace
            <select
              className="workspace-select"
              value={me.active_workspace_id}
              onChange={(e) => void switchWorkspace(Number(e.target.value))}
              disabled={workspaceBusy || busy || !historyHydrated}
              aria-label="Active workspace"
            >
              {workspaceList.length === 0 ? (
                <option value={me.active_workspace_id}>{me.active_workspace_name || 'Default'}</option>
              ) : (
                workspaceList.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            type="button"
            className="btn secondary workspace-new-btn"
            onClick={() => void addWorkspace()}
            disabled={workspaceBusy || busy || !historyHydrated}
          >
            New workspace
          </button>
          {!me.has_openai_key && (
            <p className="warn">Add your OpenAI API key in Settings before sending messages.</p>
          )}
        </div>

        <div className="sidebar-section sidebar-widget">
          <h2>Connectivity (SSH)</h2>
          <form className="ssh-form" onSubmit={(e) => void submitSsh(e)}>
            <input
              value={sshForm.name}
              onChange={(e) => setSshForm((x) => ({ ...x, name: e.target.value }))}
              placeholder="Connection name (e.g. prod)"
              required
              maxLength={128}
            />
            <input
              value={sshForm.host}
              onChange={(e) => setSshForm((x) => ({ ...x, host: e.target.value }))}
              placeholder="Host (e.g. server.example.com)"
              required
              maxLength={255}
            />
            <div className="ssh-inline">
              <input
                value={sshForm.username}
                onChange={(e) => setSshForm((x) => ({ ...x, username: e.target.value }))}
                placeholder="Username"
                required
                maxLength={128}
              />
              <input
                type="number"
                value={sshForm.port}
                onChange={(e) => setSshForm((x) => ({ ...x, port: Number(e.target.value) || 22 }))}
                min={1}
                max={65535}
                placeholder="Port"
              />
            </div>
            <select
              value={sshForm.auth_mode}
              onChange={(e) =>
                setSshForm((x) => ({
                  ...x,
                  auth_mode: e.target.value as 'private_key' | 'password' | 'private_key_password',
                }))
              }
            >
              <option value="private_key">Private key</option>
              <option value="password">Password</option>
              <option value="private_key_password">Private key + password</option>
            </select>
            {sshForm.auth_mode !== 'password' && (
              <textarea
                value={sshForm.private_key}
                onChange={(e) => setSshForm((x) => ({ ...x, private_key: e.target.value }))}
                placeholder="Private key (PEM)"
                rows={4}
                required
              />
            )}
            {sshForm.auth_mode !== 'private_key' && (
              <input
                type="password"
                value={sshForm.password}
                onChange={(e) => setSshForm((x) => ({ ...x, password: e.target.value }))}
                placeholder="Password"
                required
              />
            )}
            <button type="submit" className="btn secondary" disabled={sshBusy}>
              Save connection
            </button>
          </form>
          {sshErr && <p className="warn">{sshErr}</p>}
          {sshConnections.length > 0 && (
            <ul className="ssh-list">
              {sshConnections.map((c) => (
                <li
                  key={c.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SSH_CONNECTION_DRAG_TYPE, c.name)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  title="Drag to Toolbox > Diagnose Error"
                >
                  <div className="ssh-line">
                    <strong>{c.name}</strong>
                    <span className="muted">
                      {c.username}@{c.host}:{c.port}
                    </span>
                    <span className="muted ssh-mode">
                      {c.auth_mode === 'private_key' ? 'Key' : c.auth_mode === 'password' ? 'Password' : 'Key + Password'}
                    </span>
                  </div>
                  <div className="ssh-actions">
                    <button
                      type="button"
                      className="workspace-refresh-btn"
                      onClick={() => addDiagnoseSshConnection(c.name)}
                      disabled={sshBusy}
                    >
                      Use
                    </button>
                    <button type="button" className="workspace-refresh-btn" onClick={() => void testSsh(c.id)} disabled={sshBusy}>
                      Test
                    </button>
                    <button type="button" className="workspace-refresh-btn" onClick={() => void removeSsh(c.id)} disabled={sshBusy}>
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="sidebar-section sidebar-widget">
          <h2>
            <span>Environment</span>
            <button
              type="button"
              className="workspace-refresh-btn"
              onClick={() => setEnvironmentOpen((v) => !v)}
              aria-label={environmentOpen ? 'Collapse environment section' : 'Expand environment section'}
            >
              {environmentOpen ? 'Hide' : 'Show'}
            </button>
          </h2>
          {environmentOpen && (
            <>
              {metaErr && <p className="warn">Could not load /api/meta ({metaErr}). Is the API running?</p>}
              {meta && (
                <dl className="meta-list">
                  <div>
                    <dt>Model</dt>
                    <dd>{meta.model}</dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd title={meta.workspace}>{shortPath(meta.workspace)}</dd>
                  </div>
                  <div>
                    <dt>Base dir</dt>
                    <dd title={meta.base_dir}>{shortPath(meta.base_dir)}</dd>
                  </div>
                  {meta.user_workspace && (
                    <div>
                      <dt>Your workspace</dt>
                      <dd title={meta.user_workspace}>{shortPath(meta.user_workspace)}</dd>
                    </div>
                  )}
                  {meta.user_workspace_abs && (
                    <div>
                      <dt>Your folder (disk)</dt>
                      <dd title={meta.user_workspace_abs}>{shortPath(meta.user_workspace_abs)}</dd>
                    </div>
                  )}
                </dl>
              )}
            </>
          )}
        </div>

        <div className="sidebar-section">
          <div className="workspace-files-head">
            <h2>Workspace files</h2>
            <div className="workspace-files-actions">
              {workspaceFilesOpen && (
                <button
                  type="button"
                  className="workspace-refresh-btn"
                  onClick={() => void refreshWorkspaceFiles()}
                  disabled={workspaceFilesBusy}
                  aria-label="Refresh workspace files"
                  title="Refresh file list"
                >
                  Refresh
                </button>
              )}
              <button
                type="button"
                className="workspace-refresh-btn"
                onClick={() => setWorkspaceFilesOpen((v) => !v)}
                aria-label={workspaceFilesOpen ? 'Collapse workspace files section' : 'Expand workspace files section'}
              >
                {workspaceFilesOpen ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          {workspaceFilesOpen && (
            <>
              <input
                className="workspace-search"
                value={workspaceSearch}
                onChange={(e) => setWorkspaceSearch(e.target.value)}
                placeholder="Search files..."
                aria-label="Search workspace files"
              />
              {workspaceFilesErr && <p className="warn">Could not list files ({workspaceFilesErr}).</p>}
              {!workspaceFilesErr && filteredWorkspaceEntries.length === 0 && !workspaceFilesBusy && (
                <p className="muted workspace-empty">No files yet in this workspace.</p>
              )}
              {workspaceFilesBusy && <p className="muted workspace-empty">Loading files…</p>}
              {filteredWorkspaceEntries.length > 0 && (
                <ul className="workspace-files-list" aria-label="Workspace files">
                  {filteredWorkspaceEntries.map((entry) => (
                    <li
                      key={`${entry.type}-${entry.path}`}
                      draggable={entry.type === 'file'}
                      onDragStart={(e) => {
                        if (entry.type !== 'file') return
                        e.dataTransfer.setData(WORKSPACE_PATH_DRAG_TYPE, entry.path)
                        e.dataTransfer.setData('text/plain', entry.path)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      title={entry.type === 'file' ? 'Drag to composer to link this file' : undefined}
                    >
                      <span className="workspace-file-kind" aria-hidden>
                        {entry.type === 'dir' ? 'D' : 'F'}
                      </span>
                      <span className="workspace-file-path" title={entry.path}>
                        {entry.path}
                      </span>
                      {entry.type === 'file' && typeof entry.size === 'number' && (
                        <span className="workspace-file-size">{formatSize(entry.size)}</span>
                      )}
                      {entry.type === 'file' && (
                        <button
                          type="button"
                          className="workspace-link-btn"
                          onClick={() => addPendingWorkspacePath(entry.path)}
                          disabled={pendingWorkspacePaths.includes(entry.path)}
                        >
                          {pendingWorkspacePaths.includes(entry.path) ? 'Linked' : 'Link'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {workspaceFilesTruncated && (
                <p className="muted workspace-empty">List truncated. Narrow files or cleanup to see all entries.</p>
              )}
            </>
          )}
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="btn secondary"
            onClick={clear}
            disabled={busy || !historyHydrated || messages.length === 0}
          >
            Clear conversation
          </button>
        </div>

        <p className="brand-footer">
          <a href="https://purple-cloud.ai/" target="_blank" rel="noopener noreferrer">
            PurpleCloud
          </a>{' '}
          — Odoo cloud hosting &amp; automation
        </p>
      </aside>

      {settingsOpen && (
        <SettingsModal
          me={me}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => {
            onMeChange({ display_name: s.display_name, has_openai_key: s.has_openai_key })
            setSettingsOpen(false)
          }}
        />
      )}

      <main className="main">
        <div className="thread" ref={threadRef}>
          {busy && (
            <div className="exec-banner" aria-busy="true" aria-live="polite">
              <div className="exec-progress-track">
                <div className="exec-progress-indeterminate" />
              </div>
              <div className="exec-status">
                <span className="exec-spinner" aria-hidden />
                <span className="exec-status-text">{execStatusText}</span>
              </div>
            </div>
          )}
          {messages.length === 0 && !busy && (
            <div className="empty">
              <h2>Ask Brain AI anything</h2>
              <p>
                Plan work, edit files in your workspace, inspect git, and run tools — the same focus on clarity and
                automation as{' '}
                <a href="https://purple-cloud.ai/" target="_blank" rel="noopener noreferrer">
                  PurpleCloud
                </a>{' '}
                brings to Odoo hosting.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <article key={m.id} className={`bubble ${m.role}`}>
              {m.role === 'user' && (
                <header>
                  <span className="who">You</span>
                </header>
              )}
              {m.role === 'assistant' && (
                <header>
                  <span className="who">Brain AI</span>
                </header>
              )}
              {m.role === 'user' && (
                <>
                  {m.attachmentSummary && m.attachmentSummary.length > 0 && (
                    <ul className="attach-list" aria-label="Attachments">
                      {m.attachmentSummary.map((a, i) => (
                        <li key={`${i}-${a.path}`}>
                          <span className="attach-name">{a.name}</span>
                          <span className="attach-size">{formatSize(a.size)}</span>
                          <span className="attach-path" title={a.path}>
                            {a.path}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.content ? <p className="user-text">{m.content}</p> : null}
                  {!m.content && m.attachmentSummary?.length ? (
                    <p className="user-text muted">(no message text — attachments only)</p>
                  ) : null}
                </>
              )}
              {m.role === 'assistant' && (
                <div className="md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              )}
              {m.role === 'tool' && <ToolBlock name={m.name} args={m.args} output={m.output} />}
            </article>
          ))}

          {live && (live.tools.length > 0 || live.assistant || live.error) && (
            <div className="streaming" aria-busy="true">
              {live.tools.map((t, i) => (
                <ToolBlock key={`${t.name}-${i}`} name={t.name} args={t.args} output={t.output ?? ''} live={!t.output} />
              ))}
              {live.assistant != null && live.assistant !== '' && (
                <article className="bubble assistant">
                  <header>
                    <span className="who">Brain AI</span>
                  </header>
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.assistant}</ReactMarkdown>
                  </div>
                </article>
              )}
              {live.error && (
                <article className="bubble assistant error-bubble">
                  <p className="user-text">{live.error}</p>
                </article>
              )}
            </div>
          )}

        </div>

        <footer
          className={`composer ${dragOver ? 'composer-drop' : ''}`}
          onDragEnter={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDragOver(true)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDragLeave={(e) => {
            e.preventDefault()
            if (e.currentTarget.contains(e.relatedTarget as Node)) return
            setDragOver(false)
          }}
          onDrop={onDropFiles}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden-input"
            multiple
            onChange={onPickFiles}
            aria-hidden
            tabIndex={-1}
          />
          {pendingFiles.length > 0 && (
            <ul className="pending-files">
              {pendingFiles.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span>{f.name}</span>
                  <span className="muted">{formatSize(f.size)}</span>
                  <button type="button" className="btn-icon" onClick={() => removePending(i)} aria-label={`Remove ${f.name}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pendingWorkspacePaths.length > 0 && (
            <ul className="pending-files pending-workspace-links">
              {pendingWorkspacePaths.map((path) => (
                <li key={path}>
                  <span className="attach-name">{path.split('/').pop() || path}</span>
                  <a
                    className="workspace-link-path"
                    href={workspaceDownloadUrl(path)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={path}
                  >
                    {path}
                  </a>
                  <a className="workspace-link-download" href={workspaceDownloadUrl(path)} download title="Download file">
                    Download
                  </a>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => removePendingWorkspacePath(path)}
                    aria-label={`Remove linked file ${path}`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="composer-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                historyHydrated ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Loading saved conversation…'
              }
              rows={3}
              disabled={busy || !historyHydrated}
              aria-label="Message"
            />
            <div className="composer-actions">
              <div className="composer-secondary-col">
                <button
                  type="button"
                  className="btn secondary attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy || !historyHydrated}
                  title="Choose files (hold Cmd on Mac or Ctrl on Windows to select several). You can also drag files here."
                  aria-label="Attach one or more files"
                >
                  <IconAttach className="composer-btn-icon" />
                  <span>Attach</span>
                </button>
                <button
                  type="button"
                  className="btn secondary retry-btn"
                  onClick={() => void retry()}
                  disabled={!canRetry}
                  title="Drop assistant/tool replies after the last user message and run the model again"
                >
                  <IconRetry className="composer-btn-icon" />
                  <span>Retry</span>
                </button>
              </div>
              {busy ? (
                <button type="button" className="btn stop-btn" onClick={stop} aria-label="Stop generation">
                  <IconStop className="composer-btn-icon" />
                  <span>Stop</span>
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={() => void send()} disabled={!canSend}>
                  <IconSend className="composer-btn-icon" />
                  <span>Send</span>
                </button>
              )}
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [authBootErr, setAuthBootErr] = useState<string | null>(null)

  useEffect(() => {
    fetchMe()
      .then((u) => {
        setMe(u)
        setAuthBootErr(null)
      })
      .catch((e: Error) => setAuthBootErr(e.message))
      .finally(() => setAuthLoading(false))
  }, [])

  if (authLoading) {
    return (
      <div className="auth-shell">
        <p className="auth-loading">Loading…</p>
      </div>
    )
  }
  if (authBootErr) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Could not reach the server</h1>
          <p className="warn">{authBootErr}</p>
        </div>
      </div>
    )
  }
  if (!me) {
    return <AuthPanel onLoggedIn={setMe} />
  }
  return (
    <ChatSession
      me={me}
      onMeChange={(patch) => setMe((m) => (m ? { ...m, ...patch } : null))}
      onMeRefresh={async () => {
        const u = await fetchMe()
        if (u) setMe(u)
      }}
      onLogout={async () => {
        await logout()
        setMe(null)
      }}
    />
  )
}

function shortPath(p: string, max = 42) {
  if (p.length <= max) return p
  return `…${p.slice(-(max - 1))}`
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function workspaceDownloadUrl(path: string) {
  return `/api/workspace/download?path=${encodeURIComponent(path)}`
}

function ToolBlock({
  name,
  args,
  output,
  live,
}: {
  name: string
  args: Record<string, unknown>
  output: string
  live?: boolean
}) {
  return (
    <div className={`tool-block ${live ? 'live' : ''}`}>
      <div className="tool-head">
        <span className="tool-name">{name}</span>
        {live && <span className="tool-live">running</span>}
      </div>
      <details className="tool-details">
        <summary>Arguments</summary>
        <pre className="tool-pre">{JSON.stringify(args, null, 2)}</pre>
      </details>
      {output !== undefined && output !== '' && (
        <details className="tool-details" open={output.length < 800}>
          <summary>Result</summary>
          <pre className="tool-pre out">{output}</pre>
        </details>
      )}
    </div>
  )
}
