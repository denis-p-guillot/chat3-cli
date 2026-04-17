import type { ChatMessagePayload } from './streamChat'

export type ChatMsgPersisted =
  | {
      id: string
      role: 'user'
      content: string
      workspace_files?: string[]
      attachment_summary?: { name: string; size: number; path: string }[]
    }
  | { id: string; role: 'assistant'; content: string }
  | { id: string; role: 'tool'; name: string; args: Record<string, unknown>; output: string }

function rid(x: unknown): string {
  return typeof x === 'string' && x.length > 0 ? x : crypto.randomUUID()
}

export function serializeChatMessages(
  messages: ReadonlyArray<{
    id: string
    role: string
    content?: string
    workspaceFiles?: string[]
    attachmentSummary?: { name: string; size: number; path: string }[]
    name?: string
    args?: Record<string, unknown>
    output?: string
  }>,
): ChatMsgPersisted[] {
  const out: ChatMsgPersisted[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({
        id: m.id,
        role: 'user',
        content: m.content ?? '',
        workspace_files: m.workspaceFiles?.length ? [...m.workspaceFiles] : undefined,
        attachment_summary: m.attachmentSummary?.length ? [...m.attachmentSummary] : undefined,
      })
    } else if (m.role === 'assistant') {
      out.push({ id: m.id, role: 'assistant', content: m.content ?? '' })
    } else if (m.role === 'tool' && m.name != null && m.args != null && m.output != null) {
      out.push({
        id: m.id,
        role: 'tool',
        name: m.name,
        args: m.args,
        output: m.output,
      })
    }
  }
  return out
}

/** Restores UI message list from disk (snake_case → camelCase). */
export function deserializeChatMessages(rows: ChatMsgPersisted[]) {
  return rows.map((r) => {
    if (r.role === 'user') {
      return {
        id: rid(r.id),
        role: 'user' as const,
        content: r.content ?? '',
        workspaceFiles: r.workspace_files?.length ? [...r.workspace_files] : undefined,
        attachmentSummary: r.attachment_summary?.length ? [...r.attachment_summary] : undefined,
      }
    }
    if (r.role === 'assistant') {
      return { id: rid(r.id), role: 'assistant' as const, content: r.content ?? '' }
    }
    return {
      id: rid(r.id),
      role: 'tool' as const,
      name: r.name,
      args: r.args,
      output: r.output ?? '',
    }
  })
}

export async function fetchChatHistory(): Promise<ChatMsgPersisted[]> {
  const res = await fetch('/api/chat/history', { credentials: 'include' })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j: { detail?: unknown } = await res.json()
      if (typeof j.detail === 'string') detail = j.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const data = (await res.json()) as { messages?: unknown }
  const raw = data.messages
  if (!Array.isArray(raw)) return []
  return raw.filter((x) => x && typeof x === 'object') as ChatMsgPersisted[]
}

export async function saveChatHistory(messages: ChatMsgPersisted[]): Promise<void> {
  const res = await fetch('/api/chat/history', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ messages }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const j: { detail?: unknown } = await res.json()
      if (typeof j.detail === 'string') detail = j.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail || `HTTP ${res.status}`)
  }
}

/** Build API payload from persisted rows (user messages only carry workspace_files for replay). */
export function persistedToApiPayload(rows: ChatMsgPersisted[]): ChatMessagePayload[] {
  const out: ChatMessagePayload[] = []
  for (const m of rows) {
    if (m.role === 'user') {
      const row: ChatMessagePayload = { role: 'user', content: m.content }
      if (m.workspace_files?.length) row.workspace_files = m.workspace_files
      out.push(row)
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}
