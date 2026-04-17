/** Must stay in sync with server.py expand_user_message / format_attachment_block. */

export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 512 * 1024
export const MAX_TOTAL_ATTACHMENTS_BYTES = 2 * 1024 * 1024

export type AttachmentUpload = {
  name: string
  media_type: string
  data_base64: string
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const cleaned = base.replace(/\0/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'unnamed'
  return cleaned.slice(0, 200)
}

function formatAttachmentBlock(name: string, mediaType: string, raw: Uint8Array): string {
  const mt = mediaType.trim() || 'application/octet-stream'
  const safeName = sanitizeFilename(name)
  const textLike =
    mt.startsWith('text/') || mt === 'application/json' || mt === 'application/xml'
  if (textLike) {
    const body = new TextDecoder('utf-8', { fatal: false }).decode(raw)
    return `---\n**Attached file:** \`${safeName}\` (\`${mt}\`)\n\n\`\`\`text\n${body}\n\`\`\``
  }
  const b64 = uint8ToBase64(raw)
  return `---\n**Attached file:** \`${safeName}\` (\`${mt}\`)\n\n\`\`\`base64\n${b64}\n\`\`\``
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk)
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

export function expandUserMessageWithAttachments(text: string, attachments: AttachmentUpload[]): string {
  const parts: string[] = []
  if (text.trim()) parts.push(text.trim())
  let total = 0
  for (let i = 0; i < attachments.length; i++) {
    if (i >= MAX_ATTACHMENTS) {
      throw new Error(`Too many attachments (max ${MAX_ATTACHMENTS}).`)
    }
    const raw = base64ToUint8(attachments[i].data_base64)
    if (raw.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment "${attachments[i].name}" exceeds ${MAX_ATTACHMENT_BYTES} bytes.`)
    }
    total += raw.length
    if (total > MAX_TOTAL_ATTACHMENTS_BYTES) {
      throw new Error('Total attachment size too large.')
    }
    parts.push(formatAttachmentBlock(attachments[i].name, attachments[i].media_type, raw))
  }
  return parts.join('\n\n')
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function readFileAsAttachment(file: File): Promise<AttachmentUpload> {
  const data_base64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = r.result as string
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  return {
    name: file.name,
    media_type: file.type || 'application/octet-stream',
    data_base64,
  }
}
