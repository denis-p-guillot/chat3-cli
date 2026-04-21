/**
 * Build a self-contained HTML document from proposal Markdown (tables, GFM, Mermaid → SVG).
 * Suitable for download, browser viewing, Print → PDF, or upload to Google Drive.
 */

import { marked } from 'marked'
import mermaid from 'mermaid'
import { ensureBrainMermaidTheme } from './mermaidBrainTheme'

marked.setOptions({ gfm: true })

const PURPLECLOUD_SITE_URL = 'https://purple-cloud.ai'
const PURPLECLOUD_LOGO_URL =
  'https://purple-cloud.ai/web/image/website/2/logo/PurpleCloud%20-%20Odoo%20Cloud%20Platform-as-a-Service?unique=c506ef0'

const EXPORT_DOC_CSS = `
:root {
  --bg: #141022;
  --surface: #1c1530;
  --text: #ece8f7;
  --muted: #a39bc4;
  --border: rgba(167, 139, 250, 0.22);
  --accent: #a78bfa;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1.75rem 1.5rem 3rem;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  color: var(--text);
  background: var(--bg);
  max-width: 52rem;
  margin-left: auto;
  margin-right: auto;
}
.proposal-doc h1, .proposal-doc h2, .proposal-doc h3, .proposal-doc h4 {
  font-weight: 600;
  line-height: 1.25;
  margin: 1.25em 0 0.5em;
  color: #f5f2ff;
}
.proposal-doc h1 { font-size: 1.65rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35em; }
.proposal-doc h2 { font-size: 1.35rem; margin-top: 1.75rem; }
.proposal-doc h3 { font-size: 1.12rem; }
.proposal-doc p { margin: 0.65em 0; }
.proposal-doc ul, .proposal-doc ol { margin: 0.5em 0 0.75em 1.2em; padding: 0; }
.proposal-doc li { margin: 0.25em 0; }
.proposal-doc a { color: var(--accent); }
.proposal-doc code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88em;
  background: rgba(0,0,0,0.28);
  padding: 0.12em 0.38em;
  border-radius: 4px;
}
.proposal-doc pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  overflow-x: auto;
  font-size: 0.86rem;
}
.proposal-doc pre code { background: none; padding: 0; }
.proposal-doc table {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
  font-size: 0.92rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.proposal-doc thead { background: linear-gradient(180deg, #2a2440 0%, #1c1530 100%); }
.proposal-doc th, .proposal-doc td {
  border: 1px solid var(--border);
  padding: 0.45rem 0.65rem;
  text-align: left;
  vertical-align: top;
}
.proposal-doc th {
  font-weight: 600;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.proposal-doc tbody tr:nth-child(even) { background: rgba(0,0,0,0.15); }
.proposal-doc blockquote {
  margin: 0.75rem 0;
  padding: 0.35rem 0 0.35rem 1rem;
  border-left: 3px solid var(--accent);
  color: var(--muted);
}
.mermaid-block {
  margin: 1.1rem 0;
  padding: 1rem 1rem 0.85rem;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: linear-gradient(165deg, rgba(28, 21, 48, 0.98) 0%, rgba(20, 16, 34, 0.99) 100%);
  overflow-x: auto;
  display: flex;
  justify-content: center;
}
.mermaid-block svg { max-width: 100%; height: auto; }
.diagram-fallback { margin: 0.75rem 0; }
.export-footnote {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: 0.82rem;
  color: var(--muted);
  line-height: 1.5;
}
.export-brand-header {
  margin: 0 0 1.75rem;
  padding: 1rem 1.15rem;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: linear-gradient(135deg, rgba(45, 36, 72, 0.95) 0%, rgba(20, 16, 34, 0.98) 100%);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
}
.export-brand-lockup {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.export-brand-logo {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 11.5rem;
  max-width: 48vw;
  padding: 0.15rem 0.1rem;
}
.export-brand-logo-img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
}
.export-brand-text {
  min-width: 0;
  flex: 1;
}
.export-brand-name {
  font-size: 1.35rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  background: linear-gradient(105deg, #f5f3ff 0%, #ddd6fe 40%, #a78bfa 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.export-brand-tagline {
  margin-top: 0.2rem;
  font-size: 0.82rem;
  color: var(--muted);
  font-weight: 500;
}
.export-brand-link {
  display: inline-block;
  margin-top: 0.65rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
}
.export-brand-link:hover { text-decoration: underline; }
.export-brand-footer {
  margin-top: 2rem;
  padding: 1.15rem 1rem 0;
  border-top: 1px solid var(--border);
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.55;
  text-align: center;
}
.export-brand-footer strong {
  color: #ddd6fe;
  font-weight: 600;
}
.export-brand-footer a {
  color: var(--accent);
  text-decoration: none;
}
.export-brand-footer a:hover { text-decoration: underline; }
@media print {
  body { background: #fff; color: #111; padding: 1rem; }
  .proposal-doc h1, .proposal-doc h2, .proposal-doc h3, .proposal-doc h4 { color: #111; }
  .proposal-doc a { color: #5b21b6; }
  .export-footnote { color: #444; }
  .export-brand-header {
    background: #f4f0ff;
    border-color: #ddd6fe;
    box-shadow: none;
  }
  .export-brand-logo-img { filter: none; }
  .export-brand-name {
    background: none;
    -webkit-background-clip: unset;
    background-clip: unset;
    color: #4c1d95;
  }
  .export-brand-tagline, .export-brand-footer { color: #555; }
  .export-brand-footer strong { color: #111; }
  .export-brand-link, .export-brand-footer a { color: #5b21b6; }
}
`.trim()

function wrapExportDocument(bodyInner: string): string {
  const year = new Date().getFullYear()
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="author" content="PurpleCloud" />
  <meta name="generator" content="Brain AI — PurpleCloud proposal export" />
  <title>PurpleCloud proposal</title>
  <style>${EXPORT_DOC_CSS}</style>
</head>
<body>
  <header class="export-brand-header">
    <div class="export-brand-lockup">
      <div class="export-brand-logo">
        <img class="export-brand-logo-img" src="${PURPLECLOUD_LOGO_URL}" alt="PurpleCloud logo" />
      </div>
      <div class="export-brand-text">
        <div class="export-brand-name">PurpleCloud</div>
        <div class="export-brand-tagline">Dedicated Odoo hosting — backup, security, CI/CD &amp; monitoring</div>
      </div>
    </div>
    <a class="export-brand-link" href="${PURPLECLOUD_SITE_URL}" target="_blank" rel="noopener noreferrer">purple-cloud.ai</a>
  </header>
  <article class="proposal-doc">${bodyInner}</article>
  <p class="export-footnote">
    Generated with <strong>Brain AI</strong> (PurpleCloud proposal tools). Open this file in any browser. Use <strong>Print → Save as PDF</strong> for a PDF copy.
    You can upload the HTML or PDF to <strong>Google Drive</strong>. Native <strong>Google Docs</strong> import does not fully preserve Markdown layout and diagrams;
    for a Docs-first workflow you would need the Google Docs API with OAuth, or paste sections manually.
  </p>
  <footer class="export-brand-footer">
    <p><strong>PurpleCloud</strong> · <a href="${PURPLECLOUD_SITE_URL}" target="_blank" rel="noopener noreferrer">purple-cloud.ai</a></p>
    <p>© ${year} Purple Cloud. All rights reserved.</p>
  </footer>
</body>
</html>`
}

/**
 * Remove assistant-style follow-up suggestion cues from proposal exports.
 * We keep the proposal body intact and only strip opt-in recommendation lines.
 */
function stripExportSuggestionCues(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const shouldDropLine = (raw: string): boolean => {
    const line = raw.trim()
    if (!line) return false

    const normalized = line
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()

    const cuePatterns: RegExp[] = [
      /\bsi vous le souhaitez\b/,
      /\bsi tu le souhaites\b/,
      /\bsi vous voulez\b/,
      /\bif you('?d| would)? like\b/,
      /\bif needed,? i can\b/,
      /\bi can also\b/,
      /\bi can turn this into\b/,
      /\bje peux aussi\b/,
      /\bje peux (egalement|aussi) transformer\b/,
      /\bpuedo tambien\b/,
      /\bpuedo convertir esto\b/,
      /\bversion plus\b/,
      /\btrame de slides\b/,
      /\bslides? (deck|outline)\b/,
    ]

    return cuePatterns.some((pattern) => pattern.test(normalized))
  }

  return lines.filter((line) => !shouldDropLine(line)).join('\n').trim()
}

/**
 * Turn proposal Markdown into a standalone HTML string (async for Mermaid rendering).
 */
export async function buildProposalExportHtml(markdown: string): Promise<string> {
  const sanitizedMarkdown = stripExportSuggestionCues(markdown)
  const charts: string[] = []
  const fenced = /```mermaid\s*\n([\s\S]*?)```/gi
  const withSlots = sanitizedMarkdown.replace(fenced, (_m, body: string) => {
    charts.push(body.replace(/\r\n/g, '\n').trim())
    const idx = charts.length - 1
    return `\n\n<div class="brain-mermaid-slot" data-idx="${idx}"></div>\n\n`
  })

  ensureBrainMermaidTheme()
  const bodyHtml = (await marked.parse(withSlots)) as string

  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div id="brain-export-root">${bodyHtml}</div>`, 'text/html')
  const root = doc.getElementById('brain-export-root')
  if (!root) {
    throw new Error('Could not parse export HTML.')
  }

  const slots = root.querySelectorAll('.brain-mermaid-slot')
  for (const slot of slots) {
    const idx = Number(slot.getAttribute('data-idx'))
    const chart = charts[idx]
    if (chart == null || chart === '') {
      slot.outerHTML = '<p class="diagram-fallback">(empty diagram)</p>'
      continue
    }
    try {
      const id = `brain-exp-${idx}-${Math.random().toString(36).slice(2, 10)}`
      const { svg } = await mermaid.render(id, chart)
      const fig = doc.createElement('figure')
      fig.className = 'mermaid-block'
      fig.innerHTML = svg
      slot.replaceWith(fig)
    } catch {
      const pre = doc.createElement('pre')
      pre.className = 'diagram-fallback'
      const code = doc.createElement('code')
      code.textContent = chart
      pre.appendChild(code)
      slot.replaceWith(pre)
    }
  }

  return wrapExportDocument(root.innerHTML)
}

function proposalDownloadFilename(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `purplecloud-proposal-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.html`
}

/** Triggers a browser download of a self-contained HTML proposal. */
export async function downloadProposalAsHtml(markdown: string): Promise<void> {
  const html = await buildProposalExportHtml(markdown)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = proposalDownloadFilename()
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
