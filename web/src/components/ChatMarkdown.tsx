import { startTransition, useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import mermaid from 'mermaid'

let mermaidInitialized = false

function initMermaidOnce() {
  if (mermaidInitialized) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    themeVariables: {
      primaryColor: '#2a2440',
      primaryBorderColor: '#6d5acf',
      primaryTextColor: '#f0ecfc',
      lineColor: '#a78bfa',
      secondaryColor: '#1c1530',
      tertiaryColor: '#141022',
      mainBkg: '#1c1530',
      nodeBorder: '#7c6bb0',
      clusterBkg: 'rgba(28, 21, 48, 0.92)',
      clusterBorder: 'rgba(167, 139, 250, 0.35)',
      titleColor: '#e8e4f5',
      edgeLabelBackground: '#1c1530',
    },
    flowchart: { htmlLabels: false, curve: 'basis' },
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  })
  mermaidInitialized = true
}

function MermaidFigure({ chart }: { chart: string }) {
  const rid = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    initMermaidOnce()
    const source = chart.replace(/\n$/, '').trim()
    if (!source) {
      startTransition(() => {
        setSvg(null)
        setError(null)
      })
      return
    }
    let cancelled = false
    const renderId = `mmd-${rid}-${Math.random().toString(36).slice(2, 9)}`
    startTransition(() => {
      setSvg(null)
      setError(null)
    })
    void mermaid
      .render(renderId, source)
      .then(({ svg: out }) => {
        if (!cancelled) {
          startTransition(() => {
            setSvg(out)
            setError(null)
          })
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          startTransition(() => {
            setSvg(null)
            setError(e instanceof Error ? e.message : 'Could not render diagram')
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [chart, rid])

  if (error) {
    return (
      <div className="mermaid-block mermaid-block-error">
        <p className="mermaid-error-msg">{error}</p>
        <pre>
          <code>{chart}</code>
        </pre>
      </div>
    )
  }
  if (!svg) {
    return <div className="mermaid-block mermaid-block-loading" aria-busy="true" aria-label="Rendering diagram" />
  }
  return (
    <figure className="mermaid-block">
      <div className="mermaid-inner" dangerouslySetInnerHTML={{ __html: svg }} />
    </figure>
  )
}

const markdownComponents: Partial<Components> = {
  code({ className, children, ...props }) {
    const text = String(children).replace(/\n$/, '')
    if (className?.includes('language-mermaid')) {
      return <MermaidFigure chart={text} />
    }
    const isBlock = Boolean(/language-\w+/.test(className || '')) || text.includes('\n')
    if (isBlock) {
      return (
        <pre>
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      )
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

export function ChatMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{children}</ReactMarkdown>
}
