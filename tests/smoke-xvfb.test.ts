import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { underXvfb, xvfbArgs } from '../scripts/fixtures/xvfb.mjs'

// Why launches under xvfb take --disable-gpu: scripts/fixtures/xvfb.mjs.
describe('Electron launches on a virtual display', () => {
  const xvfb = { XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }

  // A script starts the app if it holds Electron's binary, Playwright's launcher (raw or the fixture's), or a packaged build.
  const launcher = /(?:from|require\(|import\()\s*['"]electron['"]|\b_electron\b|\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'|connectOverCDP|\bappImage\b/
  // A call that can start a process: any .launch( (Playwright's launcher, whatever it is called) or a child_process call,
  // bare or as a method (cp.spawn).
  const start = /(?:^|[^\w$])((?:[\w$]+\.)?(?:spawn|spawnSync|execFile|execFileSync|fork)|[\w$]+\.launch)\(/g
  const quotes = new Set(['\'', '"', '`'])

  /** A call's whole text from its opening parenthesis, skipping strings, templates and comments; null if it never closes. */
  function callText(source: string, open: number) {
    let depth = 0
    for (let index = open; index < source.length; index++) {
      const char = source[index]
      if (quotes.has(char)) {
        for (index++; index < source.length && source[index] !== char; index++) if (source[index] === '\\') index++
      } else if (char === '/' && source[index + 1] === '/') {
        const end = source.indexOf('\n', index)
        index = end === -1 ? source.length : end
      } else if (char === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index)
        index = end === -1 ? source.length : end + 1
      } else if (char === '(') depth++
      else if (char === ')' && --depth === 0) return source.slice(open, index + 1)
    }
    return null
  }

  /** One script's calls that start the app itself: not through the smoke fixture, and not a named tool (taskkill, ps). */
  function launchCalls(source: string) {
    // The fixture's launcher, under whatever name it is imported, adds the switch itself (checked separately).
    const fixtureImport = source.match(/import \{([^}]*)\} from '\.\/(?:fixtures\/)?smoke\.mjs'/)?.[1].match(/\belectron\b(?:\s+as\s+([\w$]+))?/)
    const fixtureLaunch = fixtureImport ? `${fixtureImport[1] ?? 'electron'}.launch` : null
    return [...source.matchAll(start)].flatMap(match => {
      if (match[1] === fixtureLaunch) return []
      const text = callText(source, match.index + match[0].length - 1)
      // A plain string, without interpolation, names a tool rather than the app.
      if (text && /^\(\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*[,)]/.test(text)) return []
      return [{ call: match[1], text }]
    })
  }
  const unswitchedCalls = (source: string) => launchCalls(source).filter(({ text }) => !text?.includes('xvfbArgs(')).map(({ call, text }) => call + (text ?? '(… never closes').split('\n')[0])

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
    const paths = ['scripts', 'scripts/fixtures'].flatMap(folder => readdirSync(folder).filter(name => /\.[cm]?[jt]s$/.test(name) && name !== 'smoke.mjs').map(name => `${folder}/${name}`))
    expect(paths).toEqual(expect.arrayContaining(Object.keys(exempt)))
    const sources = new Map(paths.filter(path => !(path in exempt)).map(path => [path, readFileSync(path, 'utf8')] as const).filter(([, source]) => launcher.test(source)))
    expect([...sources.keys()]).toEqual(expect.arrayContaining(['scripts/files-smoke.mjs', 'scripts/menus-smoke.mjs', 'scripts/fixtures/dialog-lifecycle.mjs']))
    expect([...sources].flatMap(([path, source]) => unswitchedCalls(source).map(call => `${path}: ${call}`))).toEqual([])
    // The direct launches really are examined, none passing as the fixture's.
    expect([...sources].filter(([, source]) => launchCalls(source).length).map(([path]) => path).sort())
      .toEqual(['scripts/files-smoke.mjs', 'scripts/grid-bench.mjs', 'scripts/ipc-bench.mjs', 'scripts/packaged-smoke.mjs', 'scripts/pivot-bench.mjs', 'scripts/startup-bench.mjs'])
    // Backstop for a launch form the call scan misses: a launcher that does not launch through the fixture imports xvfbArgs.
    const fromFixture = /import \{[^}]*\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'/
    const importsSwitch = /import \{[^}]*\bxvfbArgs\b[^}]*\} from '\.\/(?:fixtures\/)?xvfb\.mjs'/
    expect([...sources].filter(([, source]) => !fromFixture.test(source) && !importsSwitch.test(source)).map(([path]) => path)).toEqual([])
  })

  it('finds a launch without the switch in the forms it reads, and passes one with it', () => {
    const unswitched = [
      'import * as cp from \'node:child_process\'\ncp.spawn(electronPath, [\'.\'])',
      'import { _electron as playwright } from \'@playwright/test\'\nawait playwright.launch({ args: [\'.\'] })',
      'spawn(`${dist}/varia-sql-manager`, args)',
      'spawnSync(electronPath, [\'.\'])',
      'execFile(resolve(executable), [])',
      'const child = spawn(\n  electron,\n  [\'.\'])',
      'spawn(electronPath, [\'.\' // a comment )\n])',
      'spawn(electronPath, [\'.\''
    ]
    for (const source of unswitched) expect(unswitchedCalls(source), source).not.toEqual([])
    // A parenthesis in a string does not let one call borrow the next one's switch.
    expect(unswitchedCalls('spawn(electronPath, [\'.\', \'--x=(\'])\nspawn(electronPath, xvfbArgs([\'.\']))')).toHaveLength(1)
    const switched = [
      'cp.spawn(electronPath, xvfbArgs([\'.\']))',
      'await electron.launch({ args: xvfbArgs([\'.\']), env })',
      'import { electron } from \'./fixtures/smoke.mjs\'\nawait electron.launch(launchOptions)',
      'import { expect, electron as app } from \'./smoke.mjs\'\nawait app.launch({ args: [\'.\'] })',
      'execFileSync(\'taskkill\', [\'/PID\', pid])\nspawnSync(`ps`, [\'-axo\'])',
      'child.spawnargs; respawn(x)'
    ]
    for (const source of switched) expect(unswitchedCalls(source), source).toEqual([])
  })
})
