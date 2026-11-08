import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

// Pull request runs compete for GitHub's 20 concurrent jobs (5 macOS) across every open pull request, so the queue, not the
// jobs, set most of a run's wall time (docs/ci.md). These checks keep the cost a pull request push adds outside ci.yml small:
// packaging only when a pull request changes what packaging reads, every superseded run cancelled, and no Intel macOS
// packaging and no unused uploads before a tag.

const dir = '.github/workflows'
const text = (name: string) => readFileSync(`${dir}/${name}`, 'utf8')
const triggers = (yaml: string) => yaml.slice(yaml.indexOf('\non:'), yaml.search(/\n(concurrency|permissions|env|jobs):/))
const release = text('release.yml'), pack = text('package.yml')
const releasePaths = [...triggers(release).matchAll(/^ {6}- (\S+)$/gm)].map(match => match[1])

describe('Release builds', () => {
  it('cancels the superseded run of every workflow a pull request triggers, but never a tag or a manual run', () => {
    for (const name of readdirSync(dir).filter(file => file.endsWith('.yml'))) {
      const yaml = text(name)
      if (!/^ {2}pull_request:/m.test(triggers(yaml))) continue
      expect(yaml, name).toMatch(/\nconcurrency:\n(?: {2}#.*\n)* {2}group: .*github\.event_name == 'pull_request'.*github\.ref.*github\.run_id/)
      expect(yaml, name).toMatch(/\n {2}cancel-in-progress: true\n/)
    }
  })
  it('packages every main push, tag and manual run, and a pull request only when it changes what packaging reads', () => {
    expect(triggers(release)).toMatch(/\n {2}push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]\n {2}schedule:\n {4}- cron: '[^']+'\n {2}workflow_dispatch:/)
    // Everything electron-builder, the fuses and the packaged smoke tests read, and nothing every pull request touches:
    // the smoke selectors (scripts/fixtures/ui.mjs) and main's index changed in a third of recent pull requests.
    for (const path of ['.github/workflows/release.yml', '.github/workflows/package.yml', 'electron-builder.yml', 'build/**', 'package-lock.json', 'scripts/packaged-smoke.mjs', 'scripts/asar-contents.mjs', 'scripts/portable-smoke.mjs', 'scripts/windows-installer-smoke.ps1', 'scripts/update-manifest.mjs']) expect(releasePaths).toContain(path)
    for (const path of releasePaths) expect(path, path).not.toMatch(/^(src\/\*\*|src\/main\/index\.ts|scripts\/fixtures|package\.json|tests\/)/)
  })
  it('adds at most three jobs and one macOS job to a pull request push, and packages Intel macOS only for tags, manual runs and weekly', () => {
    const matrix = release.slice(release.indexOf('  build:\n'), release.indexOf('  build-intel:\n'))
    const runners = [...matrix.matchAll(/- runner: (\S+)/g)].map(match => match[1])
    expect(runners.length).toBeLessThanOrEqual(3)
    expect(runners.filter(runner => runner.startsWith('macos')).length).toBeLessThanOrEqual(1)
    expect(runners).not.toContain('macos-15-intel')
    const intel = release.slice(release.indexOf('  build-intel:\n'), release.indexOf('  release:\n'))
    expect(intel).toMatch(/runner: macos-15-intel/)
    // Weekly, so an x64-only break (an Electron or runner image change) shows before the tag it would block; the other
    // packages, which every main push builds, skip that run.
    expect(intel).toMatch(/\n {4}if: startsWith\(github\.ref, 'refs\/tags\/'\) \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\n/)
    expect(matrix).toMatch(/\n {4}if: github\.event_name != 'schedule'\n/)
    expect(release).toMatch(/needs: \[build, build-intel\]/)
  })
  it('keeps the packaged checks, and leaves out the work CI already did or nobody uses', () => {
    // Each packaged check runs on every packaging run: a condition on the ref or the event would quietly drop it before tags.
    const steps = pack.slice(pack.indexOf('\n    steps:\n')).split(/\n {6}- /).slice(1)
    for (const marker of ['scripts/packaged-smoke.mjs', 'scripts/portable-smoke.mjs', 'windows-installer-smoke.ps1', 'scripts/update-manifest.mjs dist', 'Check release assets', 'Package application', 'Publish self-contained backend']) {
      const step = steps.find(candidate => candidate.includes(marker))
      expect(step, marker).toBeDefined()
      expect(/\n {8}if: (.*)/.exec(step!)?.[1] ?? '', marker).not.toMatch(/github\.ref|github\.event_name/)
    }
    expect(pack).toMatch(/- name: Type check\n {8}if: startsWith\(github\.ref, 'refs\/tags\/'\)\n/)
    expect(pack).toMatch(/- name: Upload release assets\n {8}if: startsWith\(github\.ref, 'refs\/tags\/'\) \|\| github\.event_name == 'workflow_dispatch'\n/)
  })
})
