import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { underXvfb, xvfbArgs } from '../scripts/fixtures/xvfb.mjs'

// Why launches under xvfb take --disable-gpu: scripts/fixtures/xvfb.mjs.
describe('Electron launches on a virtual display', () => {
  const xvfb = { XAUTHORITY: '/tmp/xvfb-run.A5KxQZ/Xauthority' }

  // A script starts the app if it holds Electron's binary, Playwright's launcher (raw or the fixture's), or a packaged build.
  const launcher = /(?:from|require\(|import\()\s*['"]electron['"]|\b_electron\b|\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'|connectOverCDP|\bappImage\b/
  // A call that can start a process: any .launch( (Playwright's launcher, whatever it is called) or a child_process
  // function by its own name, bare or as a method (cp.spawn). exec (which RegExp shares) and aliases are left to the
  // import check below.
  const start = /(?:^|[^\w$])((?:[\w$]+\.)?(?:spawn|spawnSync|execFile|execFileSync|fork)|[\w$]+\.launch)\(/g
  const childProcess = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/
  const quotes = new Set(['\'', '"', '`'])

  /**
   * The source with every string, template, comment and regex literal blanked to spaces (same length, newlines kept), so
   * parentheses and names inside them neither count nor match; null if a string is left open. A `/` divides only after a
   * value (a name that is not a keyword, `)` or `]`), and starts a regex anywhere else.
   */
  function blank(source: string) {
    // UTF-16 units, as every index here counts (an emoji is two).
    const out = source.split('')
    const clear = (from: number, to: number) => { for (let index = from; index < to; index++) if (out[index] !== '\n') out[index] = ' ' }
    let index = 0
    while (index < source.length) {
      const char = source[index], next = source[index + 1]
      if (quotes.has(char)) {
        let close = index + 1
        // A quote or double quote ends with its line (JS allows no raw newline there); left open, the file is unreadable.
        for (; close < source.length && source[close] !== char && (char === '`' || source[close] !== '\n'); close++) if (source[close] === '\\') close++
        if (source[close] !== char) return null
        clear(index + 1, close)
        index = close + 1
      } else if (char === '/' && next === '/') {
        const close = source.indexOf('\n', index)
        clear(index, close === -1 ? source.length : close)
        index = close === -1 ? source.length : close
      } else if (char === '/' && next === '*') {
        const close = source.indexOf('*/', index + 2)
        const stop = close === -1 ? source.length : close + 2
        clear(index, stop)
        index = stop
      } else if (char === '/' && !/(?:[)\]]|(?<![\w$])(?!(?:return|typeof|case|in|of|await|yield|throw|void|delete|new|instanceof)\s*$)[\w$]+)\s*$/.test(source.slice(Math.max(0, index - 40), index))) {
        let close = index + 1, inClass = false
        for (; close < source.length && (inClass || source[close] !== '/') && source[close] !== '\n'; close++) {
          if (source[close] === '\\') close++
          else if (source[close] === '[') inClass = true
          else if (source[close] === ']') inClass = false
        }
        clear(index + 1, close)
        index = close + 1
      } else index++
    }
    return out.join('')
  }

  /** In blanked code, a call's text from its opening parenthesis to the one that closes it; null if it never closes. */
  function callText(code: string, open: number) {
    let depth = 0
    for (let index = open; index < code.length; index++) {
      if (code[index] === '(') depth++
      else if (code[index] === ')' && --depth === 0) return code.slice(open, index + 1)
    }
    return null
  }

  /** In blanked code, a declaration's value from `from`: up to a comma, semicolon or line end outside brackets. */
  function initialiser(code: string, from: number) {
    let depth = 0
    for (let index = from; index < code.length; index++) {
      const char = code[index]
      if ('([{'.includes(char)) depth++
      else if (')]}'.includes(char)) { if (--depth < 0) return code.slice(from, index) }
      else if (depth === 0 && (char === ',' || char === ';' || char === '\n')) return code.slice(from, index)
    }
    return code.slice(from)
  }

  /**
   * One script's calls that start a process itself: not through the smoke fixture, not a bare tool name (taskkill, ps), and
   * not marked on its line with `// not the app: <reason>`. Each says whether it is switched: xvfbArgs( in the call, or a
   * name the script set from xvfbArgs(. A script that cannot be read is one unswitched entry, so it fails loudly.
   */
  function launchCalls(source: string): { call: string, text: string | null, shown: string, switched: boolean }[] {
    const code = blank(source)
    if (code === null) return [{ call: '(a string left open: the script could not be read)', text: null, shown: '', switched: false }]
    // The fixture's launcher, under whatever name it is imported, adds the switch itself (checked separately).
    const fixtureImport = source.match(/import \{([^}]*)\} from '\.\/(?:fixtures\/)?smoke\.mjs'/)?.[1].match(/\belectron\b(?:\s+as\s+([\w$]+))?/)
    const fixtureLaunch = fixtureImport ? `${fixtureImport[1] ?? 'electron'}.launch` : null
    // A name is trusted only if every declaration of it in the script is initialised with xvfbArgs( in its value.
    const declarations = new Map<string, boolean>()
    for (const match of code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*/g)) {
      const value = initialiser(code, match.index + match[0].length)
      declarations.set(match[1], (declarations.get(match[1]) ?? true) && value.includes('xvfbArgs('))
    }
    const switchedNames = [...declarations].filter(([, switched]) => switched).map(([name]) => name)
    return [...code.matchAll(start)].flatMap(match => {
      if (match[1] === fixtureLaunch) return []
      const open = match.index + match[0].length - 1
      const line = source.slice(source.lastIndexOf('\n', open) + 1, source.indexOf('\n', open) === -1 ? source.length : source.indexOf('\n', open))
      if (/\/\/ not the app: \S/.test(line)) return []
      const text = callText(code, open)
      // A string literal of a bare program name (no path, no interpolation) is a tool, not the app.
      if (text && /^\(\s*(?:'[\w.-]+'|"[\w.-]+"|`[\w.-]+`)\s*[,)]/.test(source.slice(open, open + text.length)) && !/^\(\s*['"`](?:electron|varia)/i.test(source.slice(open))) return []
      const switched = !!text && (text.includes('xvfbArgs(') || switchedNames.some(name => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text)))
      return [{ call: match[1], text, shown: text ? source.slice(open, open + text.length) : '(… never closes', switched }]
    })
  }
  const fromFixture = /import \{[^}]*\belectron\b[^}]*\} from '\.\/(?:fixtures\/)?smoke\.mjs'/
  const importsSwitch = /import \{[^}]*\bxvfbArgs\b[^}]*\} from '\.\/(?:fixtures\/)?xvfb\.mjs'/
  /**
   * Whether a launcher lacks xvfbArgs where the call scan cannot see every launch: one that starts the app without the
   * fixture, or one that imports child_process (exec, an alias, promisify(execFile)), must import it.
   */
  const missesImport = (source: string) => !importsSwitch.test(source) && (!fromFixture.test(source) || childProcess.test(source))
  const unswitchedCalls = (source: string) => launchCalls(source).filter(({ switched }) => !switched).map(({ call, shown }) => call + shown.split('\n')[0])

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
      'scripts/appimage-check.mjs': 'it expects the app to refuse to start (or only extracts and checks it), so it never needs frames',
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
    expect([...sources].filter(([, source]) => missesImport(source)).map(([path]) => path)).toEqual([])
  })

  it('fails a launcher that imports child_process without xvfbArgs, whatever its calls are named', () => {
    const fixture = 'import { electron } from \'./fixtures/smoke.mjs\'\n'
    expect(missesImport(fixture + 'import { execFile } from \'node:child_process\'\nconst run = promisify(execFile)\nawait run(electronPath, [\'.\'])')).toBe(true)
    expect(missesImport(fixture + 'import { spawn as start } from \'node:child_process\'\nstart(electronPath, [\'.\'])')).toBe(true)
    expect(missesImport(fixture + 'import { exec } from \'child_process\'\nexec(`"${electronPath}" . ${file}`)')).toBe(true)
    expect(missesImport('import { _electron as electron } from \'@playwright/test\'\nawait electron.launch({ args: [\'.\'] })')).toBe(true)
    expect(missesImport(fixture + 'await electron.launch(launchOptions)')).toBe(false)
    expect(missesImport(fixture + 'import { spawn } from \'node:child_process\'\nimport { xvfbArgs } from \'./fixtures/xvfb.mjs\'')).toBe(false)
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
      'spawn(electronPath, [\'.\'',
      'spawn(\'dist/linux-unpacked/varia-sql-manager\', [\'.\'])',
      'spawn(\'electron\', [\'.\'])',
      'spawn(electronPath, [\'.\'] /* not xvfbArgs(): it is in a comment */)',
      'spawn(electronPath, [\'.\', \'xvfbArgs(\'])'
    ]
    for (const source of unswitched) expect(unswitchedCalls(source), source).not.toEqual([])
    // A parenthesis in a string does not let one call borrow the next one's switch.
    expect(unswitchedCalls('spawn(electronPath, [\'.\', \'--x=(\'])\nspawn(electronPath, xvfbArgs([\'.\']))')).toHaveLength(1)
    // Nor does one in a regex literal, wherever an expression starts (after => too), even with a quote inside it.
    expect(unswitchedCalls('step(async () => {\n  spawn(electronPath, [name.replace(/\\(/g, \'\')])\n  spawn(electronPath, xvfbArgs([\'.\']))\n})')).toHaveLength(1)
    expect(unswitchedCalls('spawn(electronPath, xvfbArgs([\'.\']))\nconst quoted = names.filter(name => /\'/.test(name))\nconst third = spawn(electronPath, [\'.\', second])')).toHaveLength(1)
    expect(unswitchedCalls('const kind = typeof /"/\nspawn(electronPath, [\'.\'])\nspawn(electronPath, xvfbArgs([\'.\']))')).toHaveLength(1)
    // Division stays division, and an open string fails the script rather than hiding what follows.
    expect(unswitchedCalls('const half = total / 2, rate = (a + b) / count\nspawn(electronPath, xvfbArgs([\'.\']))')).toEqual([])
    expect(unswitchedCalls('const broken = \'unterminated\nspawn(electronPath, xvfbArgs([\'.\']))')).toHaveLength(1)
    // A name set from xvfbArgs counts; a non-app child marked with its reason is not the app.
    expect(unswitchedCalls('const args = xvfbArgs([\'.\', file])\nspawn(electronPath, args)')).toEqual([])
    expect(unswitchedCalls('spawn(process.execPath, [helper]) // not the app: the fake backend\'s Node helper')).toEqual([])
    expect(unswitchedCalls('spawn(process.execPath, [helper])')).toHaveLength(1)
    // An object holding the switched arguments counts too, but a name declared elsewhere without the switch does not.
    expect(unswitchedCalls('const launchOptions = {\n  args: xvfbArgs([\'.\']),\n  env\n}\nawait electron.launch(launchOptions)')).toEqual([])
    expect(unswitchedCalls('function a() { const args = xvfbArgs([\'.\']); spawn(electronPath, args) }\nfunction b() {\n  const args = [\'.\', file]\n  spawn(electronPath, args)\n}')).toHaveLength(2)
    // An emoji (two UTF-16 units) earlier in the script leaves everything after it aligned.
    expect(unswitchedCalls('const sample = \'😀😀 astral\'\nexecFileSync(\'taskkill\', [\'/PID\', pid])\nspawn(electronPath, xvfbArgs([\'.\']))\nspawn(electronPath, [\'.\'])')).toEqual(['spawn(electronPath, [\'.\'])'])
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
