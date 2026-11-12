// Only known documentation paths can bypass the platform builds and runtime checks.
// Git supplies the complete diff (including both sides of renames), without GitHub's path-filter file limit.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const documentationPaths = ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md']
export function scopeForPaths(paths) {
  return paths.length > 0 && paths.every(path => documentationPaths.includes(path) || /^docs\/.+\.md$/.test(path)) ? 'docs' : 'full'
}

export function changeRange(eventName, event) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value)
  if (eventName === 'pull_request') {
    const base = event.pull_request?.base?.sha, head = event.pull_request?.head?.sha
    // Compare the whole PR to its merge base, including code from earlier commits and stacked PR bases.
    if (sha(base) && sha(head)) return `${base}...${head}`
  }
  if (eventName === 'push' && sha(event.before) && sha(event.after)) return `${event.before}..${event.after}`
  return undefined
}

export function detectScope(eventName, event, { regressionSuite = 'none', diff = range => execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), warn = console.warn } = {}) {
  if (eventName === 'workflow_dispatch') return regressionSuite === 'docs' ? 'docs' : regressionSuite && regressionSuite !== 'none' ? 'regressions' : 'full'
  const range = changeRange(eventName, event)
  if (!range) return 'full'
  try {
    return scopeForPaths(diff(range).split('\0').filter(Boolean))
  } catch {
    // Missing history (for example a force push) must run more checks, never silently omit them.
    warn('Could not compare the complete change; running full CI.')
    return 'full'
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = detectScope(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), { regressionSuite: process.env.REGRESSION_SUITE })
  appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`)
  console.log(`CI scope: ${mode}`)
}
