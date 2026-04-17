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
import { streamChat, type ChatMessagePayload } from './lib/streamChat'
import {
  activateWorkspace,
  createWorkspace,
  fetchWorkspacesList,
  type WorkspaceSummary,
} from './lib/workspaces'
import './App.css'

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
            />
          </label>
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
  const threadRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [historyHydrated, setHistoryHydrated] = useState(false)
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([])
  const [workspaceBusy, setWorkspaceBusy] = useState(false)

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

  const send = async () => {
    if (!historyHydrated) return
    const text = input.trim()
    const files = pendingFiles
    if ((!text && files.length === 0) || busy) return

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
    const workspacePaths = uploaded.map((u) => u.path)
    const attachmentSummary: { name: string; size: number; path: string }[] = uploaded.map((u) => ({
      name: u.name,
      size: u.size,
      path: u.path,
    }))

    const payload: ChatMessagePayload[] = [
      ...buildApiPayload(messages),
      workspacePaths.length
        ? { role: 'user', content: text, workspace_files: workspacePaths }
        : { role: 'user', content: text },
    ]

    setInput('')
    setPendingFiles([])
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

    setBusy(true)
    streamRef.current = { tools: [] }

    try {
      await streamChat(payload, (ev) => {
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
        setTick((x) => x + 1)
      })

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
      const msg = e instanceof Error ? e.message : String(e)
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `**Error:** ${msg}` }])
    } finally {
      setBusy(false)
      streamRef.current = { tools: [] }
      setTick((x) => x + 1)
    }
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
    if (e.dataTransfer.files?.length) mergeFilesIntoPending(e.dataTransfer.files)
  }

  const removePending = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
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

  const live = busy ? streamRef.current : null
  const canSend = historyHydrated && !busy && (input.trim().length > 0 || pendingFiles.length > 0)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div className="brand-lockup">
            <span className="brand-product">PurpleCloud</span>
            <h1 className="brand-title">Brain AI</h1>
            <p className="tagline">Intelligent assistant for your workspaces</p>
          </div>
        </div>

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
          <div className="sidebar-user-actions">
            <button type="button" className="btn secondary" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                void onLogout()
              }}
            >
              Log out
            </button>
          </div>
        </div>

        <div className="sidebar-section">
          <h2>Environment</h2>
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

        <p className="hint">
          Each <strong>workspace</strong> has its own folder: <code>workspace/users/&lt;you&gt;/w/&lt;workspace&gt;/</code>{' '}
          with <code>uploads/</code>, <code>storage/</code>, and <code>chat_messages.json</code>. Switch workspaces in the
          sidebar. Tools use the active workspace root; <strong>base_dir</strong> is the app root. OpenAI key:{' '}
          <strong>Settings</strong>.
        </p>
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

          {busy && live && live.tools.length === 0 && !live.assistant && !live.error && (
            <div className="thinking" role="status">
              <span className="pulse" />
              Working…
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
            <button
              type="button"
              className="btn secondary attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || !historyHydrated}
              title="Choose files (hold Cmd on Mac or Ctrl on Windows to select several). You can also drag files here."
              aria-label="Attach one or more files"
            >
              Attach files
            </button>
            <button type="button" className="btn primary" onClick={() => void send()} disabled={!canSend}>
              Send
            </button>
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
