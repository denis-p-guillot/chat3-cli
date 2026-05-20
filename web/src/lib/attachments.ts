/** Limits aligned with server.py */

export const MAX_ATTACHMENTS = 200
/** Max files fully summarized in one chat prompt (server also enforces a char budget). */
export const MAX_AUTO_EXPAND_FILES = 20
/** Per-file max size on disk (5 GB) */
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024
/** Max total size for one upload request (50 GB) */
export const MAX_TOTAL_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024

/** Human-readable size for UI error messages. */
export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 ** 3 && bytes % (1024 ** 3) === 0) {
    return `${bytes / 1024 ** 3} GB`
  }
  return `${Math.round(bytes / (1024 ** 2))} MB`
}

export type UploadedWorkspaceFile = {
  path: string
  name: string
  size: number
}

export async function uploadWorkspaceFiles(files: File[]): Promise<UploadedWorkspaceFile[]> {
  const fd = new FormData()
  for (const f of files) {
    fd.append('files', f)
  }
  const res = await fetch('/api/workspace/upload', {
    method: 'POST',
    credentials: 'include',
    body: fd,
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
  const data = (await res.json()) as { files: UploadedWorkspaceFile[] }
  return data.files
}
