export type StreamEvent =
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'assistant'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type ChatMessagePayload = {
  role: string
  content: string
  /** Paths relative to workspace (e.g. uploads/uuid_filename) */
  workspace_files?: string[]
}

export type StreamChatOptions = {
  /** When aborted, fetch/read rejects with AbortError; caller should treat as user stop. */
  signal?: AbortSignal
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

export async function streamChat(
  messages: ChatMessagePayload[],
  onEvent: (ev: StreamEvent) => void,
  options?: StreamChatOptions,
): Promise<void> {
  const { signal } = options ?? {}
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ messages }),
    signal,
  })
  if (!res.ok) {
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
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        try {
          onEvent(JSON.parse(trimmed.slice(6)) as StreamEvent)
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
  const tail = buffer.trim()
  if (tail) {
    for (const line of tail.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data: ')) {
        try {
          onEvent(JSON.parse(trimmed.slice(6)) as StreamEvent)
        } catch {
          /* ignore */
        }
      }
    }
  }
}
