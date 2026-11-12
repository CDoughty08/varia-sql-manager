import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { shardBudgetSeconds, shardSuites, smokeSuites, suiteSeconds } from '../scripts/smoke-shards.mjs'

// CI's own contract (docs/ci.md, Layout): validation jobs start together after scope detection, so one run reports every suite it reaches, the
// smoke suites run in shards that cover test:smoke exactly and stay within their time budget, and every pull request runs
// every platform in few enough jobs that two runs fit GitHub's concurrency for a public repository. The workflow is plain
// YAML in a fixed layout, so its jobs and steps are read by indentation.

interface Step { name: string; id?: string; if?: string; run: string; timeout?: number }
interface Job { if?: string; needs?: string; runsOn?: string; timeout?: number; matrix: Map<string, string>; steps: Step[] }
function jobs(path: string): Map<string, Job> {
  const lines = readFileSync(path, 'utf8').split('\n'), found = new Map<string, Job>()
  let inJobs = false, job: Job | undefined, step: Step | undefined, block: 'run' | undefined
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (!inJobs) continue
    const jobName = /^ {2}([\w-]+):\s*$/.exec(line)
    if (jobName) { job = { matrix: new Map(), steps: [] }; found.set(jobName[1], job); step = undefined; block = undefined; continue }
    if (!job) continue
    const own = /^ {4}(if|needs|runs-on|timeout-minutes): (.*)$/.exec(line)
    if (own) {
      const [, key, value] = own
      if (key === 'if') job.if = value
      else if (key === 'needs') job.needs = value
      else if (key === 'runs-on') job.runsOn = value
      else job.timeout = Number(value)
      continue
    }
    const axis = /^ {8}(\w+): \[(.*)\]\s*$/.exec(line)
    if (axis && !step) { job.matrix.set(axis[1], axis[2]); continue }
    const item = /^ {6}- (.*)$/.exec(line)
    if (item) { step = { name: '', run: '' }; job.steps.push(step); block = undefined }
    const field = /^ {6}(?:- | {2})(name|id|if|run|uses|timeout-minutes): ?(.*)$/.exec(line)
    if (step && field) {
      block = undefined
      const [, key, value] = field
      if (key === 'run') { if (value === '|') block = 'run'; else step.run = value }
      else if (key === 'timeout-minutes') step.timeout = Number(value)
      else if (key === 'name' || key === 'id' || key === 'if') step[key] = value
      continue
    }
    if (step && block === 'run' && /^ {10}/.test(line)) step.run += line.trim() + '\n'
  }
  return found
}
const smoke = (step: Step) => /test:smoke|-smoke\.mjs|smoke-shards\.mjs/.test(step.run)
const bench = (step: Step) => /npm run bench|check-bench/.test(step.run)
const runAlways = "needs.scope.outputs.mode == 'full'"
const liveGroups = Number(/CiGroups = (\d+);/.exec(readFileSync('backend/Varia.Backend.Tests/LiveGroups.cs', 'utf8'))?.[1])

describe('CI workflow', () => {
  const workflow = jobs('.github/workflows/ci.yml')
  const own = [...workflow].filter(([name]) => !['scope', 'docs', 'result', 'regressions'].includes(name))
  it('starts validation jobs together after scope detection, with the smoke suites and the benchmarks in jobs of their own', () => {
    for (const [name, job] of own) expect(job.needs, name).toBe('scope')
    for (const [name, job] of own) {
      const kinds = new Set(job.steps.flatMap(step => smoke(step) ? ['smoke'] : bench(step) ? ['bench'] : []))
      expect(kinds.size, name).toBeLessThanOrEqual(1)
    }
    expect(own.filter(([, job]) => job.steps.some(smoke)).map(([name]) => name)).toEqual(['smoke-linux', 'smoke-windows'])
    expect(own.filter(([, job]) => job.steps.some(bench)).map(([name]) => name)).toEqual(['bench-linux'])
    // The checks run on every platform; the live checks in LiveGroups' groups, and the live vitest suites and the Kerberos
    // check after the first group on Linux, whichever fails.
    expect(workflow.get('check')!.matrix.get('os')).toBe('ubuntu-24.04, windows-latest, macos-latest')
    expect(workflow.get('check')!.steps.find(step => step.run.trim() === 'npm run check')?.id).toBe('check')
    const live = workflow.get('live')!
    expect(live.matrix.get('group')!.split(', ').map(Number)).toEqual(Array.from({ length: liveGroups }, (_, index) => index + 1))
    expect(live.steps.find(step => step.run.trim().endsWith('--live-group ${{ matrix.group }}/' + liveGroups))?.id).toBe('test')
    for (const suite of ['tests/*-live.test.ts', 'kerberos-live']) expect(live.steps.find(step => step.run.includes(suite))?.if).toBe('matrix.group == 1 && (success() || failure())')
  })
  it('keeps triggers unfiltered, validates docs without installing runtimes, and always aggregates every job', () => {
    const yaml = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(yaml.slice(0, yaml.indexOf('\nconcurrency:'))).not.toMatch(/paths:|paths-ignore:/)
    const scope = workflow.get('scope')!, docs = workflow.get('docs')!, result = workflow.get('result')!
    expect(yaml).toContain('fetch-depth: 0')
    expect(scope.steps.some(step => step.run === 'node scripts/ci-scope.mjs')).toBe(true)
    for (const name of ['scope', 'result']) {
      const job = yaml.slice(yaml.indexOf(`\n  ${name}:`)).split(/\n {2}[\w-]+:/)[1]
      expect(job, name).not.toContain('actions/setup-node')
      expect(job, name).toContain(`sparse-checkout: scripts/ci-${name}.mjs`)
    }
    expect(yaml).toContain('options: [none, docs, dialogs, results, tail, all, activity]')
    expect(docs.needs).toBe('scope')
    expect(docs.if).toBe("needs.scope.outputs.mode == 'docs'")
    expect(docs.steps.map(step => step.run).filter(Boolean)).toEqual(['npm ci --ignore-scripts --no-audit --no-fund', "npx vitest run --exclude tests/backend-sidecar.test.ts --exclude 'tests/*-live.test.ts'"])
    expect(result.if).toBe('always()')
    expect(result.needs).toBe('[scope, docs, check, live, smoke-linux, smoke-windows, bench-linux, regressions]')
    expect(result.steps.some(step => step.run === 'node scripts/ci-result.mjs')).toBe(true)
    expect(workflow.get('regressions')!.if).toBe("needs.scope.outputs.mode == 'regressions'")
    expect(workflow.get('regressions')!.needs).toBe('scope')
  })
  it('runs every smoke suite in exactly one shard, and later Linux suites after a shard failure too', () => {
    for (const name of ['smoke-linux', 'smoke-windows']) {
      const job = workflow.get(name)!, shards = job.matrix.get('shard')!.split(',').map(Number)
      const command = job.steps.map(step => /smoke-shards\.mjs \$\{\{ matrix\.shard \}\}\/(\d+)/.exec(step.run)).find(Boolean)
      expect(Number(command?.[1]), name).toBe(shards.length)
      expect(shards, name).toEqual(shards.map((_, index) => index + 1))
      const seconds = suiteSeconds[name === 'smoke-windows' ? 'windows' : 'linux']
      expect(shardSuites(smokeSuites(), shards.length, seconds).flat().sort(), name).toEqual([...smokeSuites()].sort())
      // A slow new suite fails here rather than lengthening every run: speed it up, or add a shard.
      for (const shard of shardSuites(smokeSuites(), shards.length, seconds)) expect(shard.reduce((sum, suite) => sum + seconds[suite], 0), name).toBeLessThanOrEqual(shardBudgetSeconds)
      expect(job.steps.find(step => step.run.trim() === 'npm run build:smoke')?.id, name).toBe('build')
    }
    const linux = workflow.get('smoke-linux')!.steps, first = linux.findIndex(smoke)
    expect(linux.find(step => step.name.startsWith('Prepare the Electron sandbox'))?.id).toBe('display')
    const later = linux.slice(first + 1).filter(smoke)
    expect(later.length).toBeGreaterThan(0)
    for (const step of later) expect(step.if, step.name).toMatch(/\(success\(\) \|\| failure\(\)\) && steps\.build\.outcome == 'success' && steps\.display\.outcome == 'success'/)
  })
  it("leaves every job room for its timed steps, so a step's own limit is the one that ends it", () => {
    for (const [name, job] of own) {
      const steps = job.steps.reduce((total, step) => total + (step.timeout ?? 0), 0)
      expect(steps, name).toBeGreaterThan(0)
      expect(job.timeout, name).toBeGreaterThan(steps)
    }
  })
  it('checks bundled SQL language widgets against SQL Server with SQL Login once on Linux', () => {
    const linux = workflow.get('smoke-linux')!, step = linux.steps.find(step => step.run.includes('language-services-live-smoke.mjs'))
    expect(step?.if).toBe("matrix.shard == 3 && (success() || failure()) && steps.build.outcome == 'success' && steps.display.outcome == 'success'")
    expect(step?.run).toContain('xvfb-run -a')
    expect(step?.timeout).toBe(5)
    expect(workflow.get('smoke-windows')!.steps.some(step => step.run.includes('language-services-live-smoke.mjs'))).toBe(false)
    const yaml = readFileSync('.github/workflows/ci.yml', 'utf8'), job = yaml.slice(yaml.indexOf('  smoke-linux:'), yaml.indexOf('  smoke-windows:'))
    expect(job).toContain('image: mcr.microsoft.com/mssql/server:2022-latest')
    expect(job).toContain('VARIA_TEST_SQL_USER: sa')
  })
  it('runs every platform on every code-changing pull request, drafts included, in at most 13 jobs', () => {
    expect([...workflow.values()].map(job => job.if ?? '').filter(condition => /draft/.test(condition))).toEqual([])
    for (const [name, job] of own) expect(job.if, name).toBe(runAlways)
    const pullRequest = own.filter(([, job]) => job.if === runAlways)
    const platforms = new Set(pullRequest.flatMap(([, job]) => job.runsOn === '${{ matrix.os }}' ? job.matrix.get('os')!.split(', ') : [job.runsOn!]))
    expect([...platforms].sort()).toEqual(['macos-latest', 'ubuntu-24.04', 'windows-latest'])
    // Three smoke shards per platform keep the growing suites within their time budget, below the account's 20-job concurrency.
    const size = (job: Job) => [...job.matrix.values()].reduce((product, axis) => product * axis.split(',').length, 1)
    expect(pullRequest.reduce((sum, [, job]) => sum + size(job), 0)).toBeLessThanOrEqual(13)
    // Linux repeats at 1024x768 only on main: the Windows shards run those suites at that size on every pull request.
    for (const step of workflow.get('smoke-linux')!.steps.filter(step => /1024x768x24/.test(step.run))) expect(step.if, step.name).toMatch(/github\.event_name == 'push'/)
  })
  it('cancels superseded PR runs but preserves every running and pending main push, and keeps desktop benchmarks daily', () => {
    const yaml = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(yaml).toContain("group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}")
    expect(yaml).toMatch(/\n {2}cancel-in-progress: true\n/)
    const desktop = readFileSync('.github/workflows/bench-desktop.yml', 'utf8'), on = desktop.slice(desktop.indexOf('\non:'), desktop.indexOf('\nconcurrency:'))
    expect(on).toMatch(/\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:\n?$/)
    expect(desktop).toContain('os: [windows-latest, macos-latest]')
    // The daily run reports nothing if it loses a benchmark, or if its job's limit ends it before a step's own.
    for (const [name, job] of jobs('.github/workflows/bench-desktop.yml')) {
      const steps = job.steps.reduce((total, step) => total + (step.timeout ?? 0), 0)
      expect(steps, name).toBeGreaterThan(0)
      expect(job.timeout, name).toBeGreaterThan(steps)
      expect(job.steps.find(step => step.run.trim() === 'npm run build:smoke')?.id, name).toBe('build')
      for (const command of ['npm run bench', 'npm run bench:e2e', 'npm run bench:grid', 'scripts/check-bench.mjs']) expect(job.steps.some(step => step.run.includes(command)), command).toBe(true)
    }
  })
  // npm audit ran nowhere in CI, so dompurify and undici sat on critical and high advisories with fixes available (#267).
  // Then it ran as a step of Check (ubuntu), where an endpoint outage or an unrelated new advisory failed every pull request (#310).
  it('audits the lockfile in a workflow of its own: where the dependencies change and daily, never in a CI job', () => {
    for (const [name, job] of workflow) expect(job.steps.filter(step => /\bnpm audit\b|audit\.mjs/.test(step.run)), name).toEqual([])
    const check = workflow.get('check')!
    const at = (pattern: RegExp) => check.steps.findIndex(step => pattern.test(step.run))
    expect(at(/^npm ci\b/)).toBeLessThan(at(/\bnpm run check\b/))
    expect(check.steps[at(/\bnpm run check\b/)].if).toBeUndefined()

    const yaml = readFileSync('.github/workflows/audit.yml', 'utf8'), on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\nconcurrency:'))
    const paths = '[package.json, package-lock.json, scripts/audit.mjs, .github/workflows/audit.yml]'
    // A pull request or main push that leaves the dependencies alone starts nothing; the daily run reports advisories published since.
    expect(on).toBe(`\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n    paths: ${paths}\n  push:\n    branches: [main]\n    paths: ${paths}\n  schedule:\n    - cron: '43 6 * * *'\n  workflow_dispatch:\n`)
    expect(yaml).toContain("group: ${{ github.workflow }}-${{ (github.event_name == 'pull_request' || github.event_name == 'push') && github.ref || github.run_id }}")
    expect(yaml).toMatch(/\n {2}cancel-in-progress: true\n/)
    const audit = jobs('.github/workflows/audit.yml')
    expect([...audit.keys()]).toEqual(['audit'])
    const job = audit.get('audit')!
    expect(job.runsOn).toBe('ubuntu-24.04')
    // The lockfile alone is audited: no install. The script separates an endpoint outage from an advisory (tests/audit.test.ts).
    expect(job.steps.map(step => step.run).filter(Boolean)).toEqual(['node scripts/audit.mjs'])
    const step = job.steps.find(step => step.run)!
    expect(step.timeout).toBeGreaterThan(0)
    expect(job.timeout).toBeGreaterThan(step.timeout!)
    expect(readFileSync('scripts/audit.mjs', 'utf8')).toContain("'npm audit --package-lock-only --json --audit-level=high'")
  })
  it('type-checks on Linux in every full run, and states its job count truly', () => {
    const yaml = readFileSync('.github/workflows/ci.yml', 'utf8')
    // Windows and macOS skip tsc: it reads only sources and installed types, and Linux's case-sensitive paths are strictest.
    expect(yaml).toContain("VARIA_CHECK_SKIP: ${{ matrix.os != 'ubuntu-24.04' && 'typecheck' || '' }}")
    expect(workflow.get('check')!.matrix.get('os')!.split(', ')).toContain('ubuntu-24.04')
    const size = (job: Job) => [...job.matrix.values()].reduce((product, axis) => product * axis.split(',').length, 1)
    const count = own.filter(([, job]) => job.if === runAlways).reduce((sum, [, job]) => sum + size(job), 0)
    expect(yaml).toContain(`runs ${count + 2} jobs: ${count} validation jobs plus scope and result.`)
  })
})
