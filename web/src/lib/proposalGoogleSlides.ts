/** URL to create a blank Google Slides deck in the user's account. */
export const GOOGLE_SLIDES_NEW_URL = 'https://docs.google.com/presentation/create'

/**
 * Turn proposal Markdown into a paste-friendly outline (one block per ## section).
 * Suitable for pasting into slide titles and bodies in Google Slides.
 */
export function proposalMarkdownToSlidesOutline(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  let slide = 0
  let inMermaidFence = false
  for (const line of lines) {
    const trimmedFence = line.trim()
    if (trimmedFence.startsWith('```mermaid')) {
      inMermaidFence = true
      if (slide > 0) {
        out.push(
          '(Architecture diagram: view the rendered figure in Brain AI chat, or paste the ```mermaid block into a Mermaid-compatible editor.)',
        )
      }
      continue
    }
    if (inMermaidFence) {
      if (trimmedFence.startsWith('```')) {
        inMermaidFence = false
      }
      continue
    }
    const h2 = line.match(/^##\s+(.+)/)
    if (h2) {
      slide += 1
      out.push('')
      out.push(`━━━ Slide ${slide} ━━━`)
      out.push(`Title: ${h2[1].trim()}`)
      out.push('')
      continue
    }
    const h1 = line.match(/^#\s+(.+)/)
    if (h1 && slide === 0) {
      slide += 1
      out.push(`━━━ Slide ${slide} ━━━`)
      out.push(`Title: ${h1[1].trim()}`)
      out.push('')
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
      out.push(trimmed)
    } else if (trimmed && !trimmed.startsWith('#') && slide > 0 && trimmed.length < 400) {
      out.push(trimmed)
    }
  }
  if (out.length === 0) {
    return markdown.slice(0, 12000)
  }
  return out.join('\n').trim()
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
