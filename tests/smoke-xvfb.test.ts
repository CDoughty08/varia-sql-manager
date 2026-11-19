import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { underXvfb, xvfbArgs } from '../scripts/fixtures/xvfb.mjs'

// Why launches under xvfb take --disable-gpu: scripts/fixtures/xvfb.mjs.
describe('Electron launches on a virtual display', () => {
  const xvfb = { XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }
  // A call that can start a process: Playwright's Electron launcher or a child_process spawn, however it is named or wrapped.
  const start = /(?:^|[^\w.$])(_?electron\.launch|spawn|spawnSync|execFile|execFileSync|fork)\(/g

  it('knows xvfb-run by the XAUTHORITY it sets, on Linux only', () => {
    expect(underXvfb(xvfb, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/runner/work/_temp/xvfb-run.x1/Xauthority' }, 'linux')).toBe(true)
    expect(underXvfb({ XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toBe(false)
    expect(underXvfb({}, 'linux')).toBe(false)
    expect(underXvfb(xvfb, 'win32')).toBe(false)
  })

  it('start without the GPU under xvfb only, once, keeping the caller\'s own arguments', () => {
    expect(xvfbArgs(['.'], xvfb, 'linux')).toEqual(['.', '--disable-gpu'])
    expect(xvfbArgs(['.', 'a.sql', '--no-sandbox'], xvfb, 'linux')).toEqual(['.', 'a.sql', '--no-sandbox', '--disable-gpu'])
    expect(xvfbArgs(['.', '--disable-gpu'], xvfb, 'linux')).toEqual(['.', '--disable-gpu'])
    expect(xvfbArgs(['.'], { XAUTHORITY: '/home/user/.Xauthority' }, 'linux')).toEqual(['.'])
    expect(xvfbArgs(['.'], xvfb, 'win32')).toEqual(['.'])
  })

  // files-smoke's second instance, the packaged smoke and the benchmarks started Electron themselves, without the switch.
  it('all take their arguments from xvfbArgs, whether through the smoke fixture or launched directly', () => {
    const fixture = readFileSync('scripts/fixtures/smoke.mjs', 'utf8')
    expect(fixture).toContain('const args = xvfbArgs(options.args ?? [], env)')
    expect(fixture).toMatch(/_electron\.launch\(\{ \.\.\.options, env, args: args\.includes\(frameRateSwitch\)/)
    // Scripts that start the app themselves, and why they need no switch.
    const exempt: Record<string, string> = {
      'scripts/appimage-check.mjs': 'its runs end before a window: the refusal check expects no start, the others only extract or check',
      'scripts/portable-smoke.mjs': 'the Windows portable build, never run under xvfb'
    }
    // A script starts the app if it holds Electron's binary, Playwright's launcher (raw or the fixture's), or a packaged build.
    const launcher = /from 'electron'|\b_electron\b|\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'|connectOverCDP|\bappImage\b/
    const fromFixture = /import \{[^}]*\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'/
    // A call's whole text, across lines, up to its closing parenthesis.
    const callText = (source: string, open: number) => {
      let depth = 0
      for (let index = open; index < source.length; index++) {
        if (source[index] === '(') depth++
        else if (source[index] === ')' && --depth === 0) return source.slice(open, index + 1)
      }
      return source.slice(open)
    }
    const paths = ['scripts', 'scripts/fixtures'].flatMap(folder => readdirSync(folder).filter(name => name.endsWith('.mjs') && name !== 'smoke.mjs').map(name => `${folder}/${name}`))
    const launchers = paths.filter(path => launcher.test(readFileSync(path, 'utf8')))
    expect(launchers).toEqual(expect.arrayContaining([...Object.keys(exempt), 'scripts/files-smoke.mjs', 'scripts/packaged-smoke.mjs', 'scripts/startup-bench.mjs', 'scripts/fixtures/dialog-lifecycle.mjs']))
    const unswitched = launchers.filter(path => !(path in exempt)).flatMap(path => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(start)].flatMap(match => {
        const text = callText(source, match.index + match[0].length - 1)
        // The fixture's electron.launch adds the switch itself (checked above); a named tool (taskkill, ps) is not the app.
        if ((match[1] === 'electron.launch' && fromFixture.test(source)) || /^\(\s*['"`]/.test(text)) return []
        return text.includes('xvfbArgs(') ? [] : [`${path}: ${match[1]}${text.split('\n')[0]}`]
      })
    })
    expect(unswitched).toEqual([])
  })

  it('catches a launch however it is written', () => {
    const calls = (source: string) => [...source.matchAll(start)].map(match => match[1])
    expect(calls("_electron.launch({ args: ['.'] })\nspawnSync(electronPath, ['.'])\nexecFile(resolve(executable), [])\nconst c = spawn(\n  electron, ['.'])")).toEqual(['_electron.launch', 'spawnSync', 'execFile', 'spawn'])
    expect(calls('child.spawnargs; respawn(x); app.electron.launch(y)')).toEqual([])
  })
})
