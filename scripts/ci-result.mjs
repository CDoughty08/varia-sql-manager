// One required check covers both documentation-only runs and the complete platform matrices.
import { pathToFileURL } from 'node:url'

export const fullJobs = ['check', 'live', 'smoke-linux', 'smoke-windows', 'bench-linux']
export function resultProblems(needs) {
  const mode = needs.scope?.outputs?.mode
  if (needs.scope?.result !== 'success' || !['full', 'docs', 'regressions'].includes(mode)) return ['CI scope did not succeed with a known mode.']
  const required = mode === 'full' ? fullJobs : [mode]
  return [...fullJobs, 'docs', 'regressions'].flatMap(name => {
    const expected = required.includes(name) ? 'success' : 'skipped'
    return needs[name]?.result === expected ? [] : [`${name}: expected ${expected}, received ${needs[name]?.result ?? 'missing'}`]
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = resultProblems(JSON.parse(process.env.CI_NEEDS))
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else console.log('All checks required for this change passed.')
}
