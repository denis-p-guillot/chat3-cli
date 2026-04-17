/** Limits aligned with server.py */

export const MAX_ATTACHMENTS = 20
/** Per-file max size on disk (500 MB) */
export const MAX_FILE_BYTES = 500 * 1024 * 1024
/** Max total size for one upload request (10 GB) */
export const MAX_TOTAL_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024

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
