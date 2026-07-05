import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_VERSION = '0.6'
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(webRoot, '..')
const targetDir = process.argv[2] ? join(webRoot, process.argv[2]) : join(webRoot, 'public')

let git = 'local'
try {
  git = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim()
} catch {
  /* not a git checkout */
}

const payload = {
  app_version: APP_VERSION,
  build_id: `${git}-${Date.now()}`,
  built_at: new Date().toISOString(),
}

mkdirSync(targetDir, { recursive: true })
writeFileSync(join(targetDir, 'version.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`Wrote ${join(targetDir, 'version.json')} (${payload.build_id})`)
