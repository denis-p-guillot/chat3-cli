import { startTransition, useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import mermaid from 'mermaid'
import { ensureBrainMermaidTheme } from '../lib/mermaidBrainTheme'

function MermaidFigure({ chart }: { chart: string }) {
  const rid = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ensureBrainMermaidTheme()
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
