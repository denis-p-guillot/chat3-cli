import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  expandUserMessageWithAttachments,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENTS_BYTES,
  readFileAsAttachment,
  type AttachmentUpload,
} from './lib/attachments'
import { streamChat, type ChatMessagePayload } from './lib/streamChat'
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
  /** Full text sent to the model (includes embedded attachment blocks) */
  apiContent?: string
  attachmentSummary?: { name: string; size: number }[]
}

type ChatMsg =
  | UserMsg
  | { id: string; role: 'assistant'; content: string }
  | { id: string; role: 'tool'; name: string; args: Record<string, unknown>; output: string }

type Meta = { model: string; workspace: string; base_dir: string }

function uid() {
  return crypto.randomUUID()
}

function buildApiPayload(messages: ChatMsg[]): ChatMessagePayload[] {
  const out: ChatMessagePayload[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const u = m as UserMsg
      out.push({ role: 'user', content: u.apiContent ?? u.content })
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

export default function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const streamRef = useRef<{ tools: ToolRow[]; assistant?: string; error?: string }>({
    tools: [],
  })
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/meta')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((m: Meta) => setMeta(m))
      .catch((e: Error) => setMetaErr(e.message))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy, tick])

  const send = async () => {
    const text = input.trim()
    const files = pendingFiles
    if ((!text && files.length === 0) || busy) return

    if (files.length > MAX_ATTACHMENTS) {
      alert(`You can attach at most ${MAX_ATTACHMENTS} files.`)
      return
    }
    let total = 0
    for (const f of files) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        alert(`"${f.name}" is too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB per file).`)
        return
      }
      total += f.size
    }
    if (total > MAX_TOTAL_ATTACHMENTS_BYTES) {
      alert('Total attachment size is too large.')
      return
    }

    let uploads: AttachmentUpload[] = []
    try {
      uploads = await Promise.all(files.map((f) => readFileAsAttachment(f)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `**Error:** ${msg}` }])
      return
    }

    const userId = uid()
    const attachmentSummary = files.map((f) => ({ name: f.name, size: f.size }))

    const payload: ChatMessagePayload[] = [
      ...buildApiPayload(messages),
      uploads.length
        ? { role: 'user', content: text, attachments: uploads }
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

      if (uploads.length > 0) {
        try {
          const expanded = expandUserMessageWithAttachments(text, uploads)
          setMessages((prev) =>
            prev.map((m) => (m.id === userId && m.role === 'user' ? { ...m, apiContent: expanded } : m)),
          )
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content: `**Error:** ${msg}` }])
        }
      }
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

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list?.length) return
    setPendingFiles((prev) => {
      const next = [...prev]
      for (const f of list) {
        if (next.length >= MAX_ATTACHMENTS) break
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f)
      }
      return next
    })
    e.target.value = ''
  }

  const removePending = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const live = busy ? streamRef.current : null
  const canSend = !busy && (input.trim().length > 0 || pendingFiles.length > 0)

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <div>
            <h1>chat3</h1>
            <p className="tagline">Local technical assistant</p>
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
            </dl>
          )}
        </div>

        <div className="sidebar-actions">
          <button type="button" className="btn secondary" onClick={clear} disabled={busy || messages.length === 0}>
            Clear conversation
          </button>
        </div>

        <p className="hint">
          Tools can read and edit files under <strong>workspace</strong> and <strong>base_dir</strong>. Run the API with{' '}
          <code>OPENAI_API_KEY</code> set. Attach text or small files (up to {MAX_ATTACHMENTS} files,{' '}
          {Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB each).
        </p>
      </aside>

      <main className="main">
        <div className="thread">
          {messages.length === 0 && !busy && (
            <div className="empty">
              <h2>Start a conversation</h2>
              <p>Ask questions, request code edits in the workspace, or inspect git state. Tool calls appear as they run.</p>
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
                  <span className="who">Assistant</span>
                </header>
              )}
              {m.role === 'user' && (
                <>
                  {m.attachmentSummary && m.attachmentSummary.length > 0 && (
                    <ul className="attach-list" aria-label="Attachments">
                      {m.attachmentSummary.map((a) => (
                        <li key={a.name + a.size}>
                          <span className="attach-name">{a.name}</span>
                          <span className="attach-size">{formatSize(a.size)}</span>
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
                    <span className="who">Assistant</span>
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

          <div ref={bottomRef} />
        </div>

        <footer className="composer">
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
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            rows={3}
            disabled={busy}
            aria-label="Message"
          />
          <div className="composer-actions">
            <button
              type="button"
              className="btn secondary attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label="Attach files"
            >
              Attach
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
