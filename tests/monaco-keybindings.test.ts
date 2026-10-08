import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { defaultRules, nativeChordPrefixes, parseKeySpec, platforms, reservedReason, workbenchRules, type Platform } from '../src/shared/commands/keybindings'

/**
 * Keybinding drift against Monaco. The workbench dispatcher runs before Monaco (a capture listener on window), so a
 * workbench key that Monaco also binds silently takes it from the editor. This reads every keybinding in the Monaco
 * modules the renderer loads and fails when a workbench key collides without a reviewed reason.
 */
const monacoRoot = join('node_modules', 'monaco-editor', 'esm', 'vs')
// The Monaco modules main.tsx imports. Adding a contrib changes Monaco's keys, so it must be reviewed here.
const reviewedImports = [
  'monaco-editor/editor/editor.api.js',
  'monaco-editor/languages/definitions/sql/register.js',
  'monaco-editor/editor/contrib/find/browser/findController.js',
  'monaco-editor/editor/contrib/clipboard/browser/clipboard.js',
  'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js',
  'monaco-editor/editor/contrib/comment/browser/comment.js',
  'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js',
  'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js',
  'monaco-editor/editor/contrib/hover/browser/hoverContribution.js',
  'monaco-editor/features/codicon/register.js'
]
/** Workbench keys Monaco also binds, each with the reason the workbench may have it. Unused entries fail the test. */
const monacoShadowAllowlist: Readonly<Record<string, string>> = {
  'mod+enter': 'query.execute owns it in the editor, as addAction did (⌘↩ is replace-all in the macOS find widget)',
  'f8': 'Show Object Explorer, as in SSMS; Monaco\'s next-problem has nothing to visit, because the SQL language reports no markers',
  'ctrl+e': 'Execute (Windows and Linux only, as in SSMS); Monaco binds ⌘E (find with selection) and ⌃E only on macOS',
  'ctrl+pageup': 'Previous Query (Windows and Linux only); Monaco binds ⌘PageUp only on macOS and Alt+PageUp elsewhere',
  'ctrl+pagedown': 'Next Query (Windows and Linux only); Monaco binds ⌘PageDown only on macOS and Alt+PageDown elsewhere'
}

const keyNames: Readonly<Record<string, string>> = {
  Enter: 'enter', Escape: 'escape', Tab: 'tab', Space: 'space', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', UpArrow: 'up', DownArrow: 'down', LeftArrow: 'left', RightArrow: 'right', PauseBreak: 'pause', ContextMenu: 'contextmenu',
  Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`'
}
function keyName(code: string): string | undefined {
  const match = /^(?:Key([A-Z])|Digit([0-9])|(F[0-9]{1,2}))$/.exec(code)
  return match ? (match[1] ?? match[2] ?? match[3]).toLowerCase() : keyNames[code]
}

/** Every module reachable from `entries` through relative static imports. */
function moduleClosure(entries: readonly string[]): string[] {
  const seen = new Set<string>(), queue = [...entries]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:^|[;\s])(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+\.js)['"]/g)) {
      const target = resolve(dirname(file), match[1])
      if (existsSync(target)) queue.push(target)
    }
  }
  return [...seen].sort()
}

const part = String.raw`(?:\d+ \/\* KeyMod\.\w+ \*\/\s*\|\s*)*\d+ \/\* KeyCode\.\w+ \*\/`
/**
 * The chords bound anywhere in `files`, in Monaco's `N /* KeyMod.X *\/ | N /* KeyCode.Y *\/` output, resolved for
 * `platform`. Bindings in `mac:`, `win:`, and `linux:` blocks are treated as applying everywhere, which over-reports
 * safely. CtrlCmd is Ctrl, or ⌘ on macOS; WinCtrl is the Windows/Super key, or Ctrl on macOS.
 */
function monacoChords(files: readonly string[], platform: Platform): Map<string, Set<string>> {
  const modifier: Readonly<Record<string, string>> = { CtrlCmd: platform === 'darwin' ? 'meta' : 'ctrl', WinCtrl: platform === 'darwin' ? 'ctrl' : 'meta', Shift: 'shift', Alt: 'alt' }
  const order = ['ctrl', 'shift', 'alt', 'meta']
  const chord = (source: string) => {
    const key = keyName(/KeyCode\.(\w+)/.exec(source)![1])
    if (!key) return undefined
    const pressed = new Set([...source.matchAll(/KeyMod\.(\w+)/g)].map(match => modifier[match[1]]))
    return [...order.filter(name => pressed.has(name)), key].join('+')
  }
  const found = new Map<string, Set<string>>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('primary:')) continue
    for (const match of source.matchAll(new RegExp(String.raw`KeyChord\(\s*(${part})\s*,\s*(${part})\s*\)|(${part})`, 'g'))) {
      const parts = match[3] ? [chord(match[3])] : [chord(match[1]), chord(match[2])]
      if (parts.some(value => value === undefined)) continue
      const text = parts.join(' ')
      if (!found.has(text)) found.set(text, new Set())
      found.get(text)!.add(relative(monacoRoot, file))
    }
  }
  return found
}

const files = moduleClosure(reviewedImports.map(specifier => join(monacoRoot, specifier.slice('monaco-editor/'.length))))
const chordsByPlatform = new Map(platforms.map(platform => [platform, monacoChords(files, platform)]))

describe('Monaco keybinding drift', () => {
  it('reviews every Monaco module main.tsx imports', () => {
    const source = readFileSync(join('src', 'renderer', 'src', 'main.tsx'), 'utf8')
    const imports = [...source.matchAll(/^import\s+(?:[^'"]*\sfrom\s+)?['"](monaco-editor\/[^'"?]+)['"]/gm)].map(match => match[1])
    expect(imports).toEqual(reviewedImports)
  })
  it('reads the keys Monaco binds today', () => {
    const win = chordsByPlatform.get('win32')!, mac = chordsByPlatform.get('darwin')!
    for (const chord of ['ctrl+f', 'ctrl+h', 'f3', 'shift+f3', 'alt+enter', 'ctrl+/', 'shift+alt+a', 'ctrl+z', 'ctrl+y', 'ctrl+shift+z', 'alt+c', 'ctrl+enter', 'f8', 'ctrl+k ctrl+c', 'ctrl+k ctrl+u', 'ctrl+k ctrl+i']) {
      expect(win.has(chord), chord).toBe(true)
    }
    for (const chord of ['meta+f', 'alt+meta+f', 'meta+e', 'ctrl+e', 'ctrl+p', 'meta+k meta+c', 'shift+meta+z']) expect(mac.has(chord), chord).toBe(true)
    expect(files.length).toBeGreaterThan(100)
  })
  it.each(platforms)('leaves Monaco its keys on %s unless a collision is reviewed', platform => {
    const monaco = chordsByPlatform.get(platform)!
    const allowed = new Set(Object.keys(monacoShadowAllowlist).map(spec => parseKeySpec(spec, platform).join(' ')))
    const collisions = [...workbenchRules(defaultRules(platform))].flatMap(([chord, rules]) => monaco.has(chord) && !allowed.has(chord)
      ? [`${chord} (${rules.map(rule => rule.command).join(', ')}) is bound by ${[...monaco.get(chord)!].join(', ')}`] : [])
    expect(collisions).toEqual([])
  })
  it('keeps every allowlist entry in use', () => {
    for (const spec of Object.keys(monacoShadowAllowlist)) {
      const used = platforms.some(platform => {
        const chord = parseKeySpec(spec, platform).join(' ')
        return chordsByPlatform.get(platform)!.has(chord) && workbenchRules(defaultRules(platform)).has(chord)
      })
      expect(used, spec).toBe(true)
    }
  })
  it.each(platforms)("reserves Monaco's chord prefixes on %s", platform => {
    const prefixes = new Set([...chordsByPlatform.get(platform)!.keys()].filter(chord => chord.includes(' ')).map(chord => chord.split(' ')[0]))
    expect([...prefixes]).toEqual([platform === 'darwin' ? 'meta+k' : 'ctrl+k'])
    for (const prefix of prefixes) expect(reservedReason(prefix, platform), prefix).toBeDefined()
    // The dispatcher passes the key after these through to Monaco, so Monaco's chords keep working in editor text.
    expect([...nativeChordPrefixes(platform)]).toEqual([...prefixes])
  })
  it.each(platforms)('labels only keys Monaco really binds as native on %s', platform => {
    const monaco = chordsByPlatform.get(platform)!
    // Electron dispatches the keys of role-backed commands (Zoom In, Exit): their native menu items carry them.
    for (const rule of defaultRules(platform).filter(rule => rule.native && !commandDescriptor(rule.command).role)) expect(monaco.has(rule.chords.join(' ')), `${rule.command} ${rule.chords.join(' ')}`).toBe(true)
  })
  it('leaves Ctrl+R and ⌘R to the results pane toggle: Monaco binds neither', () => {
    for (const platform of platforms) {
      const chord = platform === 'darwin' ? 'meta+r' : 'ctrl+r'
      expect(chordsByPlatform.get(platform)!.has(chord), platform).toBe(false)
      expect(workbenchRules(defaultRules(platform)).get(chord)?.map(rule => rule.command), platform).toEqual(['view.toggleResultsPane'])
      expect(chordsByPlatform.get(platform)!.has(platform === 'darwin' ? 'shift+meta+r' : 'ctrl+shift+r'), platform).toBe(false)
    }
  })
})
