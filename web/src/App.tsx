import { useEffect, useMemo, useRef, useState } from 'react'
import { ChatMarkdown } from './components/ChatMarkdown'
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
import {
  GOOGLE_SLIDES_NEW_URL,
  copyTextToClipboard,
  proposalMarkdownToSlidesOutline,
} from './lib/proposalGoogleSlides'
import {
  buildPurpleCloudProposalRequest,
  emptyProposalForm,
  resolveCatalogTierForSizing,
  validateProposalForm,
} from './lib/proposalPrompt'
import { renderDiagnoseHtmlReport, runDiagnoseErrorStream } from './lib/tools'
import { DiagnoseToolboxWidget } from './components/DiagnoseToolboxWidget'
import { ProposalToolboxWidget } from './components/ProposalToolboxWidget'
import { ConnectivityWidget, type SshFormState } from './components/ConnectivityWidget'
import { WorkspaceFilesWidget } from './components/WorkspaceFilesWidget'
import { EnvironmentWidget } from './components/EnvironmentWidget'
import { AccountWidget } from './components/AccountWidget'
import { DEFAULT_SIDEBAR_WIDGETS, type SidebarWidgetsState, parseSidebarWidgets } from './lib/sidebarWidgets'
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

type NoticeTone = 'info' | 'success' | 'error'

type Notice = {
  id: string
  message: string
  tone: NoticeTone
}

function uid() {
  return crypto.randomUUID()
}

/** Show paired HTML report next to diagnostics_summary.md even if only MD is stored in pin state. */
function expandPinnedWorkspacePaths(paths: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    if (!seen.has(p)) {
      out.push(p)
      seen.add(p)
    }
    if (/diagnostics_summary\.md$/i.test(p)) {
      const html = p.replace(/diagnostics_summary\.md$/i, 'issue_analysis.html')
      if (!seen.has(html)) {
        out.push(html)
        seen.add(html)
      }
    }
  }
  return out
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

function IconClear({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 6V4.8A1.8 1.8 0 019.8 3h4.4A1.8 1.8 0 0116 4.8V6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.8 6l.8 13.2A2 2 0 009.6 21h4.8a2 2 0 001.99-1.8L17.2 6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 10.2v6.2M14 10.2v6.2" />
    </svg>
  )
}

function IconSidebarAccount({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 21a8 8 0 10-16 0" />
      <circle cx="12" cy="8.5" r="3.5" />
    </svg>
  )
}

function IconSidebarDiagnose({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12h3M10 6v12M15 4.5v15M19.5 9h-3" />
    </svg>
  )
}

function IconSidebarProposal({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6M9 16h6M7 4h7l5 5v13a1 1 0 01-1 1H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 4v4h4" />
    </svg>
  )
}

function IconSidebarConnectivity({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 20l-4-4 4-4M16 4l4 4-4 4M10.5 13.5l3-3" />
    </svg>
  )
}

function IconSidebarEnvironment({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <rect x="3.5" y="4" width="17" height="14" rx="2" />
      <path strokeLinecap="round" d="M7 8.5h5M7 12h10M7 15.5h7" />
    </svg>
  )
}

function IconSidebarWorkspaceFiles({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6.5A2.5 2.5 0 016.5 4H14l4 4v11.5A2.5 2.5 0 0115.5 20h-9A2.5 2.5 0 014 17.5V6.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 4v4h4" />
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
              <span className="form-label-caption">
                Display name <span className="optional">(optional)</span>
              </span>
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
  const [workspaceSearch, setWorkspaceSearch] = useState('')
  const [pendingWorkspacePaths, setPendingWorkspacePaths] = useState<string[]>([])
  /** Hide auto-expanded issue_analysis.html row until MD is unpinned or workspace changes. */
  const [suppressedHtmlPaths, setSuppressedHtmlPaths] = useState<string[]>([])
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([])
  const [sshBusy, setSshBusy] = useState(false)
  const [sshErr, setSshErr] = useState<string | null>(null)
  const [sshEditorOpen, setSshEditorOpen] = useState(false)
  const [sshEditingName, setSshEditingName] = useState<string | null>(null)
  const [sshForm, setSshForm] = useState<SshFormState>({
    name: '',
    host: '',
    port: 22,
    username: '',
    auth_mode: 'private_key' as 'private_key' | 'password' | 'private_key_password',
    private_key: '',
    password: '',
  })
  const [sidebarWidgets, setSidebarWidgets] = useState<SidebarWidgetsState>(DEFAULT_SIDEBAR_WIDGETS)
  const [sidebarWidgetsHydrated, setSidebarWidgetsHydrated] = useState(false)
  const [diagnoseBusy, setDiagnoseBusy] = useState(false)
  const [diagnoseErr, setDiagnoseErr] = useState<string | null>(null)
  const [diagnoseContext, setDiagnoseContext] = useState('')
  const [diagnoseSshConnections, setDiagnoseSshConnections] = useState<string[]>([])
  const [toolboxDragOver, setToolboxDragOver] = useState(false)
  const [proposalBusy, setProposalBusy] = useState(false)
  const [proposalErr, setProposalErr] = useState<string | null>(null)
  const [proposalForm, setProposalForm] = useState(emptyProposalForm)
  /** After a successful Run Proposal, offer Google Slides export for the assistant Markdown. */
  const [proposalSlidesBanner, setProposalSlidesBanner] = useState<{ markdown: string } | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])
  const [pinnedPathsHydrated, setPinnedPathsHydrated] = useState(false)

  const pushNotice = (message: string, tone: NoticeTone = 'info') => {
    const id = uid()
    setNotices((prev) => [...prev, { id, message, tone }])
    window.setTimeout(() => {
      setNotices((prev) => prev.filter((n) => n.id !== id))
    }, 4200)
  }

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

  const refreshWorkspaceFiles = async (): Promise<WorkspaceEntry[]> => {
    setWorkspaceFilesBusy(true)
    setWorkspaceFilesErr(null)
    try {
      const data = await fetchWorkspaceFiles()
      setWorkspaceEntries(data.entries)
      setWorkspaceFilesTruncated(data.truncated)
      return data.entries
    } catch (e) {
      setWorkspaceEntries([])
      setWorkspaceFilesTruncated(false)
      setWorkspaceFilesErr(e instanceof Error ? e.message : String(e))
      return []
    } finally {
      setWorkspaceFilesBusy(false)
    }
  }

  useEffect(() => {
    void refreshWorkspaceFiles()
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    setWorkspaceSearch('')
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    setSuppressedHtmlPaths([])
  }, [me.id, me.active_workspace_id])

  useEffect(() => {
    setPinnedPathsHydrated(false)
    const key = `pc:pinnedWorkspacePaths:${me.id}`
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setPendingWorkspacePaths(parsed.filter((x): x is string => typeof x === 'string'))
        }
      }
    } catch {
      /* keep current in-memory pins if storage is unavailable */
    }
    setPinnedPathsHydrated(true)
  }, [me.id])

  useEffect(() => {
    if (!pinnedPathsHydrated) return
    const key = `pc:pinnedWorkspacePaths:${me.id}`
    try {
      window.localStorage.setItem(key, JSON.stringify(pendingWorkspacePaths))
    } catch {
      /* ignore local storage write failures */
    }
  }, [me.id, pinnedPathsHydrated, pendingWorkspacePaths])

  useEffect(() => {
    setSidebarWidgetsHydrated(false)
    const key = `pc:sidebarWidgets:${me.id}`
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) setSidebarWidgets(parseSidebarWidgets(JSON.parse(raw)))
      else setSidebarWidgets({ ...DEFAULT_SIDEBAR_WIDGETS })
    } catch {
      setSidebarWidgets({ ...DEFAULT_SIDEBAR_WIDGETS })
    }
    setSidebarWidgetsHydrated(true)
  }, [me.id])

  useEffect(() => {
    if (!sidebarWidgetsHydrated) return
    const key = `pc:sidebarWidgets:${me.id}`
    try {
      window.localStorage.setItem(key, JSON.stringify(sidebarWidgets))
    } catch {
      /* ignore */
    }
  }, [me.id, sidebarWidgetsHydrated, sidebarWidgets])

  const toggleSidebarWidget = (id: keyof SidebarWidgetsState) => {
    setSidebarWidgets((w) => {
      const next = !w[id]
      if (id === 'diagnose' && !next) setToolboxDragOver(false)
      if ((id === 'diagnose' || id === 'proposal') && !next) {
        setDiagnoseErr(null)
        setProposalErr(null)
      }
      return { ...w, [id]: next }
    })
  }

  const effectivePinnedPaths = useMemo(
    () => expandPinnedWorkspacePaths(pendingWorkspacePaths).filter((p) => !suppressedHtmlPaths.includes(p)),
    [pendingWorkspacePaths, suppressedHtmlPaths],
  )

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

  const runStream = async (
    payload: ChatMessagePayload[],
    streamOpts?: { proposalTrace?: boolean },
  ): Promise<string> => {
    const proposalTrace = streamOpts?.proposalTrace ?? false
    let proposalAssistantChunks = 0
    const ac = new AbortController()
    abortRef.current = ac
    abortReasonRef.current = null
    lastStreamEventAtRef.current = Date.now()
    setBusy(true)
    streamRef.current = { tools: [] }
    let assistantOutput = ''
    try {
      if (proposalTrace) {
        console.log(
          '%c[PurpleCloud Proposal]',
          'color:#c4b5fd;font-weight:bold',
          'Step 4 — POST /api/chat/stream (SSE); waiting for events…',
        )
      }
      await streamChat(
        payload,
        (ev) => {
          const s = streamRef.current
          if (ev.type === 'tool_call') {
            if (proposalTrace) {
              console.log(
                '%c[PurpleCloud Proposal]',
                'color:#c4b5fd;font-weight:bold',
                'Tool call:',
                ev.name,
                ev.arguments,
              )
            }
            s.tools.push({ name: ev.name, args: ev.arguments, output: undefined })
          } else if (ev.type === 'tool_result') {
            if (proposalTrace) {
              console.log(
                '%c[PurpleCloud Proposal]',
                'color:#c4b5fd;font-weight:bold',
                `Tool result (${ev.name}):`,
                ev.output.length > 600 ? `${ev.output.slice(0, 600)}…` : ev.output,
              )
            }
            for (let i = s.tools.length - 1; i >= 0; i--) {
              if (s.tools[i].name === ev.name && s.tools[i].output === undefined) {
                s.tools[i] = { ...s.tools[i], output: ev.output }
                break
              }
            }
          } else if (ev.type === 'assistant') {
            if (proposalTrace && ev.content && proposalAssistantChunks === 0) {
              proposalAssistantChunks = 1
              console.log(
                '%c[PurpleCloud Proposal]',
                'color:#c4b5fd;font-weight:bold',
                'Streaming assistant Markdown (first tokens received)…',
              )
            }
            s.assistant = ev.content
          } else if (ev.type === 'error') {
            if (proposalTrace) {
              console.log('%c[PurpleCloud Proposal]', 'color:#f87171;font-weight:bold', 'Stream error:', ev.message)
            }
            s.error = ev.message
          }
          lastStreamEventAtRef.current = Date.now()
          setTick((x) => x + 1)
        },
        { signal: ac.signal },
      )

      const fin = streamRef.current
      if (fin.assistant) {
        assistantOutput = fin.assistant
      }
      if (proposalTrace) {
        console.log(
          '%c[PurpleCloud Proposal]',
          'color:#c4b5fd;font-weight:bold',
          'Step 5 — Stream finished.',
          {
            toolCalls: fin.tools.length,
            assistantChars: fin.assistant?.length ?? 0,
            error: fin.error ?? null,
          },
        )
      }
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
        if (fin.assistant) {
          assistantOutput = fin.assistant
        }
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
    return assistantOutput
  }

  const send = async (opts?: {
    text?: string
    linkedPaths?: string[]
    /** Log proposal pipeline steps to the browser console (DevTools). */
    proposalTrace?: boolean
  }): Promise<string> => {
    if (!historyHydrated) return ''
    const text = (opts?.text ?? input).trim()
    const files = pendingFiles
    const linkedPaths =
      opts?.linkedPaths ??
      expandPinnedWorkspacePaths(pendingWorkspacePaths).filter((p) => !suppressedHtmlPaths.includes(p))
    if ((!text && files.length === 0 && linkedPaths.length === 0) || busy) return ''

    if (files.length > MAX_ATTACHMENTS) {
      pushNotice(`You can attach at most ${MAX_ATTACHMENTS} files.`, 'error')
      return ''
    }
    let total = 0
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        pushNotice(`"${f.name}" is too large (max ${MAX_FILE_BYTES / (1024 * 1024)} MB per file).`, 'error')
        return ''
      }
      total += f.size
    }
    if (total > MAX_TOTAL_UPLOAD_BYTES) {
      pushNotice(
        `Total upload size is too large (max ${MAX_TOTAL_UPLOAD_BYTES / (1024 * 1024)} MB per request).`,
        'error',
      )
      return ''
    }

    let uploaded: UploadedWorkspaceFile[] = []
    if (files.length > 0) {
      try {
        uploaded = await uploadWorkspaceFiles(files)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `**Error:** ${msg}` }])
        return ''
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

    if (opts?.text != null) {
      setInput((prev) => (prev === opts.text ? '' : prev))
    } else {
      setInput('')
    }
    setPendingFiles([])
    // Keep pinned workspace links until the user explicitly unpins them.
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

    return await runStream(payload, { proposalTrace: opts?.proposalTrace })
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
    if (/diagnostics_summary\.md$/i.test(path)) {
      setPendingWorkspacePaths((prev) => prev.filter((p) => p !== path))
      const html = path.replace(/diagnostics_summary\.md$/i, 'issue_analysis.html')
      setSuppressedHtmlPaths((prev) => prev.filter((p) => p !== html))
    } else if (/issue_analysis\.html$/i.test(path)) {
      setSuppressedHtmlPaths((prev) => (prev.includes(path) ? prev : [...prev, path]))
      setPendingWorkspacePaths((prev) => prev.filter((p) => p !== path))
    } else {
      setPendingWorkspacePaths((prev) => prev.filter((p) => p !== path))
    }
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
      pushNotice(e instanceof Error ? e.message : String(e), 'error')
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
      pushNotice(`Workspace "${trimmed}" created and activated.`, 'success')
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setWorkspaceBusy(false)
    }
  }

  const submitSsh = async () => {
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
      setSshEditingName(null)
      setSshEditorOpen(false)
      await refreshSshConnections()
    } catch (err) {
      setSshErr(err instanceof Error ? err.message : String(err))
    } finally {
      setSshBusy(false)
    }
  }

  const startNewSsh = () => {
    setSidebarWidgets((w) => ({ ...w, connectivity: true }))
    setSshEditorOpen(true)
    setSshEditingName(null)
    setSshForm({
      name: '',
      host: '',
      port: 22,
      username: '',
      auth_mode: 'private_key',
      private_key: '',
      password: '',
    })
  }

  const editSsh = (c: SshConnection) => {
    setSidebarWidgets((w) => ({ ...w, connectivity: true }))
    setSshEditorOpen(true)
    setSshEditingName(c.name)
    setSshForm({
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      auth_mode: c.auth_mode,
      private_key: '',
      password: '',
    })
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
        pushNotice(`SSH test successful. ${res.stdout || '(no output)'}`, 'success')
      } else {
        pushNotice(`SSH test failed. ${res.stderr || '(no error output)'}`, 'error')
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
      let liveBlock = '[Diagnose Error Run Stages]\n'
      let lastStep = ''
      setInput((prev) => (prev.trim() ? `${prev.trim()}\n\n${liveBlock}` : liveBlock))
      const out = await runDiagnoseErrorStream(diagnoseContext, diagnoseSshConnections, {
        onActivity: (step) => {
          if (step === lastStep) return
          lastStep = step
          liveBlock += `- ${step}\n`
          setInput((prev) => {
            const marker = '[Diagnose Error Run Stages]'
            const markerPos = prev.lastIndexOf(marker)
            if (markerPos < 0) {
              return prev.trim() ? `${prev.trim()}\n\n${liveBlock}` : liveBlock
            }
            const prefix = prev.slice(0, markerPos).trim()
            return prefix ? `${prefix}\n\n${liveBlock}` : liveBlock
          })
        },
      })
      addPendingWorkspacePath(out.path)
      if (/diagnostics_summary\.md$/i.test(out.path)) {
        addPendingWorkspacePath(out.path.replace(/diagnostics_summary\.md$/i, 'issue_analysis.html'))
      }
      await refreshWorkspaceFiles()
      setDiagnoseContext('')
      setDiagnoseSshConnections([])
      const finalLines: string[] = []
      if (Array.isArray(out.activity) && out.activity.length > 0) {
        for (const step of out.activity) finalLines.push(`- ${step}`)
      }
      finalLines.push(`- Output artifact prepared: ${out.name}`)
      finalLines.push(`- Linked workspace artifact: ${out.path}`)
      const finalBlock = [
        '[Diagnose Error Run Stages]',
        ...finalLines,
        '',
        'Continue immediately: inspect linked artifacts, summarize the top 5 findings, state the most likely root cause, list recommended next actions, and propose a remediation plan. Do NOT claim files were updated; provide analysis content only. This content will be embedded into the final issue_analysis report.',
      ].join('\n')
      setInput((prev) => {
        const marker = '[Diagnose Error Run Stages]'
        const markerPos = prev.lastIndexOf(marker)
        if (markerPos < 0) return prev.trim() ? `${prev.trim()}\n\n${finalBlock}` : finalBlock
        const prefix = prev.slice(0, markerPos).trim()
        return prefix ? `${prefix}\n\n${finalBlock}` : finalBlock
      })
      pushNotice(`Diagnostics artifact linked: ${out.name}`, 'success')
      const followupAssistantRaw = await send({ text: finalBlock, linkedPaths: [out.path] })
      const followupAssistant = followupAssistantRaw
        .replace(/^done\s*[—-].*$/gim, '')
        .replace(/^.*updated the final report in:.*$/gim, '')
        .trim()
      let htmlPathCandidate = out.path.replace(/diagnostics_summary\.md$/i, 'issue_analysis.html')
      try {
        const html = await renderDiagnoseHtmlReport(undefined, undefined, undefined, followupAssistant)
        htmlPathCandidate = html.path
        pushNotice(`Final HTML report generated: ${html.name}`, 'success')
      } catch (err) {
        pushNotice(`Final HTML report generation failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
      await refreshWorkspaceFiles()
      setPendingWorkspacePaths((prev) => {
        const next = [...prev]
        if (!next.includes(out.path)) next.push(out.path)
        if (!next.includes(htmlPathCandidate)) next.push(htmlPathCandidate)
        return next
      })
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

  const runProposal = async () => {
    setProposalErr(null)
    setProposalSlidesBanner(null)
    if (!historyHydrated) {
      setProposalErr('Chat is not ready yet.')
      return
    }
    if (busy || diagnoseBusy) return
    const valid = validateProposalForm(proposalForm)
    if (!valid.ok) {
      setProposalErr(valid.message)
      return
    }
    setProposalBusy(true)
    try {
      console.log('%c[PurpleCloud Proposal]', 'color:#c4b5fd;font-weight:bold', 'Step 1 — Validation passed.')
      console.log('%c[PurpleCloud Proposal]', 'color:#c4b5fd;font-weight:bold', 'Step 2 — Computing grid / sizing…')
      const text = buildPurpleCloudProposalRequest(proposalForm)
      console.log('%c[PurpleCloud Proposal]', 'color:#c4b5fd;font-weight:bold', 'Step 3 — Prompt built.', {
        chars: text.length,
        catalogTier: resolveCatalogTierForSizing(proposalForm),
        language: proposalForm.proposalLanguage,
        fileStoreGb: proposalForm.fileStoreSizeGb,
        instances: {
          dev: proposalForm.includeDevInstance,
          staging: proposalForm.includeStagingInstance,
          production: proposalForm.includeProductionInstance,
        },
      })
      const reply = await send({ text, proposalTrace: true })
      setProposalForm(emptyProposalForm())
      pushNotice('PurpleCloud proposal request sent.', 'success')
      const clean = reply.trim()
      if (clean.length > 80 && !/^\*\*Error:\*\*/m.test(clean)) {
        setProposalSlidesBanner({ markdown: clean })
      }
    } catch (err) {
      console.log('%c[PurpleCloud Proposal]', 'color:#f87171;font-weight:bold', 'Failed:', err)
      setProposalErr(err instanceof Error ? err.message : String(err))
    } finally {
      setProposalBusy(false)
    }
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
  const canSend =
    historyHydrated &&
    !busy &&
    (input.trim().length > 0 || pendingFiles.length > 0 || effectivePinnedPaths.length > 0)
  const canRetry = historyHydrated && !busy && canRetryFromMessages(messages)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-top">
            <div className="brand-left">
              <span className="brand-mark" aria-hidden />
              <div className="brand-lockup">
                <span className="brand-product">PurpleCloud</span>
                <h1 className="brand-title">Brain AI</h1>
                <p className="tagline">Version 0.6</p>
              </div>
            </div>
            <div className="brand-toolbar-actions" role="toolbar" aria-label="Account actions">
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
          <div className="brand-toolbar-widgets" role="toolbar" aria-label="Show or hide sidebar panels">
            <button
              type="button"
              className={`icon-btn ${sidebarWidgets.account ? 'icon-btn-active' : ''}`}
              onClick={() => toggleSidebarWidget('account')}
              title="Account & workspace"
              aria-label="Toggle Account & workspace panel"
              aria-pressed={sidebarWidgets.account}
            >
              <IconSidebarAccount />
            </button>
            <button
              type="button"
              className={`icon-btn ${sidebarWidgets.diagnose ? 'icon-btn-active' : ''}`}
              onClick={() => toggleSidebarWidget('diagnose')}
              title="Diagnose Error"
              aria-label="Toggle Diagnose Error panel"
              aria-pressed={sidebarWidgets.diagnose}
            >
              <IconSidebarDiagnose />
            </button>
            <button
              type="button"
              className={`icon-btn ${sidebarWidgets.proposal ? 'icon-btn-active' : ''}`}
              onClick={() => toggleSidebarWidget('proposal')}
              title="Proposal"
              aria-label="Toggle Proposal panel"
              aria-pressed={sidebarWidgets.proposal}
            >
              <IconSidebarProposal />
            </button>
            <button
              type="button"
              className={`icon-btn ${sidebarWidgets.connectivity ? 'icon-btn-active' : ''}`}
              onClick={() => toggleSidebarWidget('connectivity')}
              title="Connectivity (SSH)"
              aria-label="Toggle Connectivity panel"
              aria-pressed={sidebarWidgets.connectivity}
            >
              <IconSidebarConnectivity />
            </button>
            <button
              type="button"
              className={`icon-btn ${sidebarWidgets.environment ? 'icon-btn-active' : ''}`}
              onClick={() => toggleSidebarWidget('environment')}
              title="Environment"
              aria-label="Toggle Environment panel"
              aria-pressed={sidebarWidgets.environment}
            >
              <IconSidebarEnvironment />
            </button>
            <button
              type="button"
              className={`icon-btn ${sidebarWidgets.workspaceFiles ? 'icon-btn-active' : ''}`}
              onClick={() => toggleSidebarWidget('workspaceFiles')}
              title="Workspace files"
              aria-label="Toggle Workspace files panel"
              aria-pressed={sidebarWidgets.workspaceFiles}
            >
              <IconSidebarWorkspaceFiles />
            </button>
          </div>
        </div>

        {sidebarWidgets.account && (
          <AccountWidget
            me={me}
            workspaceList={workspaceList}
            workspaceBusy={workspaceBusy}
            busy={busy}
            historyHydrated={historyHydrated}
            onSwitchWorkspace={(id) => void switchWorkspace(id)}
            onAddWorkspace={() => void addWorkspace()}
          />
        )}

        {sidebarWidgets.diagnose && (
          <DiagnoseToolboxWidget
            dragOver={toolboxDragOver}
            diagnoseBusy={diagnoseBusy}
            diagnoseErr={diagnoseErr}
            diagnoseContext={diagnoseContext}
            diagnoseSshConnections={diagnoseSshConnections}
            sshDragType={SSH_CONNECTION_DRAG_TYPE}
            onDragOverState={setToolboxDragOver}
            onDropSshConnection={addDiagnoseSshConnection}
            onRemoveDiagnoseSshConnection={removeDiagnoseSshConnection}
            onDiagnoseContextChange={setDiagnoseContext}
            onRunDiagnose={() => void diagnoseError()}
          />
        )}

        {sidebarWidgets.proposal && (
          <ProposalToolboxWidget
            chatBusy={busy}
            diagnoseBusy={diagnoseBusy}
            proposalBusy={proposalBusy}
            proposalErr={proposalErr}
            proposalForm={proposalForm}
            onProposalFormChange={(patch) => setProposalForm((prev) => ({ ...prev, ...patch }))}
            onRunProposal={() => void runProposal()}
          />
        )}

        {sidebarWidgets.connectivity && (
          <ConnectivityWidget
            busy={sshBusy}
            error={sshErr}
            editorOpen={sshEditorOpen}
            editingName={sshEditingName}
            form={sshForm}
            connections={sshConnections}
            sshDragType={SSH_CONNECTION_DRAG_TYPE}
            onStartNew={startNewSsh}
            onCloseEditor={() => {
              setSshEditorOpen(false)
              setSshEditingName(null)
            }}
            onFormChange={setSshForm}
            onSubmit={() => void submitSsh()}
            onEdit={editSsh}
            onTest={(id) => void testSsh(id)}
            onDelete={(id) => void removeSsh(id)}
          />
        )}

        {sidebarWidgets.environment && (
          <EnvironmentWidget meta={meta} metaErr={metaErr} shortPath={shortPath} />
        )}

        {sidebarWidgets.workspaceFiles && (
          <WorkspaceFilesWidget
            busy={workspaceFilesBusy}
            error={workspaceFilesErr}
            truncated={workspaceFilesTruncated}
            entries={workspaceEntries}
            search={workspaceSearch}
            pendingWorkspacePaths={pendingWorkspacePaths}
            workspaceDragType={WORKSPACE_PATH_DRAG_TYPE}
            onRefresh={() => void refreshWorkspaceFiles()}
            onSearchChange={setWorkspaceSearch}
            onLinkPath={addPendingWorkspacePath}
            formatSize={formatSize}
          />
        )}

        <p className="brand-footer">
          <a href="https://purple-cloud.ai/" target="_blank" rel="noopener noreferrer">
            PurpleCloud
          </a>{' '}
          — Odoo Infra &amp; AI
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
        {notices.length > 0 && (
          <div className="toast-stack" aria-live="polite">
            {notices.map((n) => (
              <div key={n.id} className={`toast toast-${n.tone}`}>
                <span>{n.message}</span>
                <button
                  type="button"
                  className="toast-close"
                  onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))}
                  aria-label="Dismiss notification"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
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
                  <ChatMarkdown>{m.content}</ChatMarkdown>
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
                    <ChatMarkdown>{live.assistant}</ChatMarkdown>
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

        {proposalSlidesBanner && (
          <div className="proposal-slides-banner" role="region" aria-label="Export proposal to Google Slides">
            <div className="proposal-slides-banner-inner">
              <div className="proposal-slides-banner-copy">
                <strong>Proposal generated</strong>
                <p className="muted proposal-slides-banner-text">
                  Open a new Google Slides deck, then paste the copied outline into slide titles and bodies (one block per
                  section). Mermaid architecture diagrams are omitted from the outline—keep the chat open for the visual,
                  or recreate shapes in Slides. You can tweak formatting after paste.
                </p>
              </div>
              <div className="proposal-slides-banner-actions">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={async () => {
                    const outline = proposalMarkdownToSlidesOutline(proposalSlidesBanner.markdown)
                    const ok = await copyTextToClipboard(outline)
                    pushNotice(
                      ok ? 'Slide outline copied to clipboard.' : 'Could not copy — select text manually in the chat.',
                      ok ? 'success' : 'error',
                    )
                  }}
                >
                  Copy slide-ready outline
                </button>
                <a
                  className="btn primary proposal-slides-open"
                  href={GOOGLE_SLIDES_NEW_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open new Google Slides
                </a>
                <button
                  type="button"
                  className="btn secondary proposal-slides-dismiss"
                  onClick={() => setProposalSlidesBanner(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}

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
          {effectivePinnedPaths.length > 0 && (
            <ul className="pending-files pending-workspace-links">
              {effectivePinnedPaths.map((path) => (
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
                <button
                  type="button"
                  className="btn secondary clear-btn"
                  onClick={clear}
                  disabled={busy || !historyHydrated || messages.length === 0}
                  title="Clear conversation"
                  aria-label="Clear conversation"
                >
                  <IconClear className="composer-btn-icon" />
                  <span>Clear</span>
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
