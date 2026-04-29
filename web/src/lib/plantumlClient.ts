/**
 * Render PlantUML via the Brain API (proxies to PLANTUML_SERVER / plantuml.com).
 */

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

async function postPlantuml(format: 'svg' | 'png', source: string): Promise<Response> {
  return fetch('/api/tools/plantuml/render', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, format }),
  })
}

export async function renderPlantumlSvg(source: string): Promise<string> {
  const res = await postPlantuml('svg', source)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(t || res.statusText)
  }
  return await res.text()
}

export async function renderPlantumlPngDataUrl(source: string): Promise<string> {
  const res = await postPlantuml('png', source)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(t || res.statusText)
  }
  return await blobToDataUrl(await res.blob())
}
