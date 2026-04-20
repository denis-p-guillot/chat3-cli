import mermaid from 'mermaid'

let initialized = false

/** Shared Mermaid theme for chat preview and HTML export downloads. */
export function ensureBrainMermaidTheme(): void {
  if (initialized) return
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
  initialized = true
}
