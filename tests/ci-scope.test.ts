import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// @ts-expect-error The workflow entry point is plain JavaScript.
import { changeRange, detectScope, scopeForPaths } from '../scripts/ci-scope.mjs'
// @ts-expect-error The workflow entry point is plain JavaScript.
import { fullJobs, resultProblems } from '../scripts/ci-result.mjs'

const base = 'a'.repeat(40), head = 'b'.repeat(40)
describe('CI scope', () => {
  it('uses the documentation lane only for a nonempty change consisting entirely of known documentation paths', () => {
    for (const file of ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md', 'docs/ci.md', 'docs/themes/tokens.md']) expect(scopeForPaths([file]), file).toBe('docs')
    for (const file of ['src/main/index.ts', 'backend/Service.cs', '.github/workflows/ci.yml', 'scripts/check.mjs', 'tests/example.test.ts', 'package.json', 'package-lock.json', 'global.json', 'build/README.md', 'release-notes/0.8.0.json', 'docs/themes/varia-theme.schema.json', 'docs/example.ts', 'unknown.txt']) expect(scopeForPaths(['README.md', file]), file).toBe('full')
    expect(scopeForPaths([])).toBe('full')
    expect(scopeForPaths([...Array.from({ length: 3500 }, (_, i) => `docs/${i}.md`), 'src/main/index.ts'])).toBe('full')
  })
  it('compares the whole PR against its base', () => {
    const pr = { pull_request: { base: { sha: base }, head: { sha: head } } }
    expect(changeRange('pull_request', pr)).toBe(`${base}...${head}`)
    expect(changeRange('push', { before: base, after: head })).toBeUndefined()
    expect(changeRange('push', { before: '0'.repeat(40), after: head })).toBeUndefined()
    expect(changeRange('pull_request', { pull_request: { base: { sha: '--output=bad' }, head: { sha: head } } })).toBeUndefined()
    expect(detectScope('pull_request', pr, { diff: (range: string) => { expect(range).toBe(`${base}...${head}`); return 'README.md\0src/main/index.ts\0' } })).toBe('full')
    expect(detectScope('pull_request', pr, { diff: () => 'docs/a file with spaces.md\0README.md\0' })).toBe('docs')
  })
  it('runs full CI for missing history, unknown events and empty comparisons, and honors manual runs', () => {
    const event = { pull_request: { base: { sha: base }, head: { sha: head } } }
    expect(detectScope('pull_request', event, { diff: () => { throw new Error('missing commit') }, warn: () => {} })).toBe('full')
    expect(detectScope('pull_request', event, { diff: () => '' })).toBe('full')
    expect(detectScope('push', {})).toBe('full')
    expect(detectScope('unknown', {})).toBe('full')
    expect(detectScope('workflow_dispatch', {}, { regressionSuite: 'none' })).toBe('full')
    expect(detectScope('workflow_dispatch', {}, { regressionSuite: 'docs' })).toBe('docs')
    expect(detectScope('workflow_dispatch', {}, { regressionSuite: 'dialogs' })).toBe('regressions')
  })
  it('always replaces the full main workload, even when the newest push changes only docs', () => {
    let compared = false
    for (const regressionSuite of ['none', 'docs', 'dialogs']) {
      expect(detectScope('push', { before: base, after: head }, { regressionSuite, diff: () => { compared = true; return 'README.md\0' } })).toBe('full')
    }
    expect(compared).toBe(false)
  })

  let directory: string | undefined
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })
  it('reads real Git history and renames even with global signing and hooks configured', () => {
    mkdirSync('artifacts', { recursive: true })
    directory = mkdtempSync(resolve('artifacts/ci-scope-'))
    const emptyHooks = join(directory, 'empty-hooks'), hostileHooks = join(directory, 'hostile-hooks'), globalConfig = join(directory, 'gitconfig')
    mkdirSync(emptyHooks)
    mkdirSync(hostileHooks)
    writeFileSync(join(hostileHooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(globalConfig, `[commit]\n  gpgsign = true\n[gpg]\n  program = varia-ci-fixture-missing-signer\n[core]\n  hooksPath = "${hostileHooks.replaceAll('\\', '/')}"\n`)
    // Keep this repository independent of the machine's config, templates and GIT_* environment overrides.
    // The hostile config proves real commits still work when signing and hooks are enabled globally.
    const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${emptyHooks}`, '-c', `init.templateDir=${emptyHooks}`, ...args], { cwd: directory, env: gitEnv, encoding: 'utf8', timeout: 10000 }).trim()
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.name', 'CI fixture')
    git('config', 'user.email', 'ci-fixture@example.invalid')
    writeFileSync(join(directory, 'README.md'), 'before')
    writeFileSync(join(directory, 'code.ts'), 'export const x = 1')
    git('add', 'README.md', 'code.ts')
    git('commit', '--quiet', '-m', 'Initial fixture')
    const initial = git('rev-parse', 'HEAD')
    const classify = (event: object, eventName = 'pull_request') => {
      const output = join(directory!, 'output'), eventPath = join(directory!, 'event.json')
      writeFileSync(output, '')
      writeFileSync(eventPath, JSON.stringify(event))
      execFileSync(process.execPath, [resolve('scripts/ci-scope.mjs')], { cwd: directory, env: { ...gitEnv, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output }, encoding: 'utf8', timeout: 10000 })
      return readFileSync(output, 'utf8')
    }
    writeFileSync(join(directory, 'README.md'), 'after')
    git('add', 'README.md'); git('commit', '--quiet', '-m', 'Docs only')
    const docsHead = git('rev-parse', 'HEAD')
    expect(classify({ pull_request: { base: { sha: initial }, head: { sha: docsHead } } })).toBe('mode=docs\n')
    expect(classify({ before: initial, after: docsHead }, 'push')).toBe('mode=full\n')
    // Moving code into a documentation path must still detect its deleted source path.
    mkdirSync(join(directory, 'docs'))
    renameSync(join(directory, 'code.ts'), join(directory, 'docs/code.md'))
    git('add', 'code.ts', 'docs/code.md'); git('commit', '--quiet', '-m', 'Rename code to docs')
    writeFileSync(join(directory, 'README.md'), 'one more doc edit')
    git('add', 'README.md'); git('commit', '--quiet', '-m', 'Later docs change')
    const final = git('rev-parse', 'HEAD')
    expect(classify({ pull_request: { base: { sha: docsHead }, head: { sha: final } } })).toBe('mode=full\n')
    expect(classify({ before: docsHead, after: final }, 'push')).toBe('mode=full\n')
  })
})

describe('required CI result', () => {
  type Need = { result: string; outputs?: { mode: string } }
  const needsFor = (mode: string): Record<string, Need> => ({
    scope: { result: 'success', outputs: { mode } },
    ...Object.fromEntries([...fullJobs, 'docs', 'regressions'].map((name: string) => [name, { result: (mode === 'full' ? fullJobs.includes(name) : name === mode) ? 'success' : 'skipped' }]))
  })
  it('accepts complete full, documentation and focused regression runs', () => {
    for (const mode of ['full', 'docs', 'regressions']) expect(resultProblems(needsFor(mode))).toEqual([])
  })
  it('rejects failed, cancelled, skipped or missing selected jobs, including any failed platform matrix', () => {
    for (const [mode, names] of [['full', fullJobs], ['docs', ['docs']], ['regressions', ['regressions']]] as [string, string[]][]) {
      for (const name of names) for (const result of ['failure', 'cancelled', 'skipped', 'missing']) {
        const needs = needsFor(mode)
        if (result === 'missing') delete needs[name]
        else needs[name].result = result
        expect(resultProblems(needs), `${mode}: ${name} ${result}`).not.toEqual([])
      }
    }
  })
  it('rejects failed classification, unknown modes and failures in supposedly unselected jobs', () => {
    const needs = needsFor('docs')
    needs.scope.result = 'failure'
    expect(resultProblems(needs)).not.toEqual([])
    expect(resultProblems(needsFor('unknown'))).not.toEqual([])
    expect(resultProblems({})).not.toEqual([])
    const unexpected = needsFor('docs')
    unexpected.check.result = 'failure'
    expect(resultProblems(unexpected)).not.toEqual([])
  })
})
