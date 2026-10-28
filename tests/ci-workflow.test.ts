import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// CI's own contract (CLAUDE.md, Conventions): one run reports every suite it reaches, and every pull request runs every
// platform. The workflow is plain YAML in a fixed layout, so its jobs and steps are read by indentation.

interface Step { name: string; id?: string; if?: string; run: string }
function jobs(path: string): Map<string, { if?: string; steps: Step[] }> {
  const lines = readFileSync(path, 'utf8').split('\n'), found = new Map<string, { if?: string; steps: Step[] }>()
  let inJobs = false, job: { if?: string; steps: Step[] } | undefined, step: Step | undefined, block: 'run' | undefined
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (!inJobs) continue
    const jobName = /^ {2}([\w-]+):\s*$/.exec(line)
    if (jobName) { job = { steps: [] }; found.set(jobName[1], job); step = undefined; block = undefined; continue }
    if (!job) continue
    const jobIf = /^ {4}if: (.*)$/.exec(line)
    if (jobIf) { job.if = jobIf[1]; continue }
    const item = /^ {6}- (.*)$/.exec(line)
    if (item) { step = { name: '', run: '' }; job.steps.push(step); block = undefined }
    const field = /^ {6}(?:- | {2})(name|id|if|run|uses): ?(.*)$/.exec(line)
    if (step && field) {
      block = undefined
      const [, key, value] = field
      if (key === 'run') { if (value === '|') block = 'run'; else step.run = value }
      else if (key === 'name' || key === 'id' || key === 'if') step[key] = value
      continue
    }
    if (step && block === 'run' && /^ {10}/.test(line)) step.run += line.trim() + '\n'
  }
  return found
}
const smoke = (step: Step) => /test:smoke|-smoke\.mjs/.test(step.run)
const bench = (step: Step) => /npm run bench|check-bench/.test(step.run)
const independent = (step: Step) => /\(success\(\) \|\| failure\(\)\)/.test(step.if ?? '') && /steps\.check\.outcome == 'success'/.test(step.if ?? '')

describe('CI workflow', () => {
  const workflow = jobs('.github/workflows/ci.yml')
  it('runs the smoke suites and the benchmarks whichever of them fails first, once the build passed', () => {
    for (const name of ['linux', 'desktop']) {
      const steps = workflow.get(name)!.steps
      expect(steps.find(step => step.run.trim() === 'npm run check')?.id, name).toBe('check')
      const first = steps.findIndex(step => smoke(step) || bench(step))
      const later = steps.slice(first + 1).filter(step => smoke(step) || bench(step))
      expect(later.length, name).toBeGreaterThan(0)
      expect(later.filter(step => !independent(step)).map(step => step.name), name).toEqual([])
    }
    // The Linux smoke steps also need the sandbox and display prepared.
    const linux = workflow.get('linux')!.steps
    expect(linux.find(step => step.name.startsWith('Prepare the Electron sandbox'))?.id).toBe('display')
    expect(linux.filter(smoke).every(step => step.if?.includes("steps.display.outcome == 'success'"))).toBe(true)
  })
  it('runs every platform on every pull request, drafts included', () => {
    expect([...workflow.values()].map(job => job.if ?? '').filter(condition => /draft/.test(condition))).toEqual([])
    expect(workflow.get('desktop')!.if).toBe("github.event_name != 'workflow_dispatch' || inputs.regression-suite == 'none'")
  })
})
