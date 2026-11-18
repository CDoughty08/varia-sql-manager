import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseArgs, suitePath, wslEnvNames } from '../scripts/smoke-wsl.mjs'

// Linux-only smoke failures (Electron reports minimize and maximize differently there) turned up only in CI after a push;
// scripts/smoke-wsl.mjs runs the suites on Linux through WSL first.
describe('smoke-wsl', () => {
  it('reads suites and flags, and refuses what it does not know', () => {
    expect(parseArgs(['options', 'menus', '--no-build'])).toMatchObject({ suites: ['options', 'menus'], build: false, committed: false, all: false })
    expect(parseArgs(['--setup'])).toMatchObject({ setup: true, suites: [] })
    expect(parseArgs(['--all', '--distro', 'Ubuntu-26.04', '--committed'])).toMatchObject({ all: true, distro: 'Ubuntu-26.04', committed: true })
    expect(() => parseArgs([])).toThrow(/at least one suite/)
    expect(() => parseArgs(['--all', 'options'])).toThrow(/not both/)
    expect(() => parseArgs(['--distro'])).toThrow(/needs a name/)
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/)
  })

  it('names a suite however it is written, and only a suite', () => {
    for (const name of ['options', 'options-smoke', 'options-smoke.mjs', 'scripts/options-smoke.mjs', 'scripts\\options-smoke.mjs', './scripts/options-smoke.mjs']) {
      expect(suitePath(name)).toBe('scripts/options-smoke.mjs')
    }
    expect(() => suitePath('../x')).toThrow(/Not a suite/)
    expect(() => suitePath('a;rm -rf ~')).toThrow(/Not a suite/)
  })

  it('passes the lock tier and test variables into WSL by name only', () => {
    const names = wslEnvNames({ WSLENV: 'USERPROFILE/p', VARIA_LOCK_HELD: 'shared', VARIA_TEST_SQL_PASSWORD: 'secret', VARIA_SMOKE_PROFILE: 'x', VARIA_WSL_CLONE: '/c', VARIA_LOCK_DIR: 'd', PATH: 'p' })
    expect(names.split(':')).toEqual(['USERPROFILE/p', 'VARIA_LOCK_HELD', 'VARIA_TEST_SQL_PASSWORD', 'VARIA_SMOKE_PROFILE', 'VARIA_WSL_CLONE'])
    expect(names).not.toContain('secret')
  })

  it('keeps the Linux half runnable: LF endings and every phase the runner calls', () => {
    const shell = readFileSync('scripts/smoke-wsl.sh', 'utf8')
    expect(shell).not.toContain('\r')
    for (const phase of ['setup', 'prepare', 'suites']) expect(shell).toMatch(new RegExp(`^  ${phase}\\) ${phase} "\\$@" ;;$`, 'm'))
    expect(shell).toContain("xvfb-run -a -s '-screen 0 1600x1000x24'")
  })
})
