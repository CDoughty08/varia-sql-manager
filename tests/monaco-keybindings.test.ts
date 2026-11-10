// @vitest-environment happy-dom
// The runtime checks below load the real Monaco, which needs a DOM; the drift checks only read files.
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { commandDescriptor } from '../src/shared/commands/catalog'
import { loadMonaco, loadMonacoFor, monacoKeyRows, omittedContextKeys, renderMonacoKeys, reviewedImports, type LoadedMonaco } from './fixtures/monaco-runtime'
import { monacoKeyRules, monacoRuleWhen } from '../src/shared/commands/monaco-keys.generated'
import { bridgeRules, defaultRules, nativeChordPrefixes, parseKeySpec, platforms, reservedReason, workbenchRules, type Platform } from '../src/shared/commands/keybindings'

/**
 * Keybinding drift against Monaco. The workbench dispatcher runs before Monaco (a capture listener on window), so a
 * workbench key that Monaco also binds silently takes it from the editor. This reads every keybinding in the Monaco
 * modules the renderer loads and fails when a workbench key collides without a reviewed reason.
 */
const monacoRoot = join('node_modules', 'monaco-editor', 'esm', 'vs')
/** Workbench keys Monaco also binds, each with the reason the workbench may have it. Unused entries fail the test. */
const monacoShadowAllowlist: Readonly<Record<string, string>> = {
  'mod+enter': 'query.execute owns it in the editor, as addAction did (⌘↩ is replace-all in the macOS find widget)',
  'f8': 'Show Object Explorer, as in SSMS; Monaco\'s next-problem has nothing to visit, because the SQL language reports no markers',
  'ctrl+e': 'Execute (Windows and Linux only, as in SSMS); Monaco binds ⌘E (find with selection) and ⌃E only on macOS',
  'ctrl+pageup': 'Previous Query (Windows and Linux only); Monaco binds ⌘PageUp only on macOS and Alt+PageUp elsewhere',
  'ctrl+pagedown': 'Next Query (Windows and Linux only); Monaco binds ⌘PageDown only on macOS and Alt+PageDown elsewhere',
  'shift+f10': "workbench.showContextMenu replaces Monaco's menu (contextmenu: false), so Shift+F10 opens the workbench's editor menu",
  'contextmenu': 'the context-menu key, likewise (Windows and Linux)',
  'delete': "Delete in Object Explorer's tree only (activePanel == 'explorer' && !textInputFocus && !searchHitsFocus), and Close Query on a focused document tab (documentTabFocus && !inputFocus); Monaco's deleteRight acts in editor text",
  'backspace': "Close Query on a focused document tab (documentTabFocus && !inputFocus), as Dockview's tabs close; Monaco's deleteLeft acts in editor text",
  'cmd+backspace': "Delete in Object Explorer's tree on macOS, as in Finder; Monaco's deleteWordLeft acts in editor text",
  'ctrl+g': 'Go To Line, as in SSMS (Windows and Linux); Monaco binds ⌘G (next match) only on macOS',
  'f4': "The table designer's Properties (designerFocus): its grid is outside the editor, so Monaco's next reference keeps F4 in editor text",
  'alt+f12': "Peek in Object Explorer's tree only (activePanel == 'explorer' && !inputFocus && !searchHitsFocus), as VS Code's Peek Definition; Monaco's peek keeps Alt+F12 in editor text",
  'space': "Peek on Space in Object Explorer's tree only (explorerFocus && !textInputFocus && !explorerTypeAhead); Monaco's widgets keep Space in editor text",
  'mod+c': "Copy in a results grid only (outputGridFocus): the grid is outside the editor, so Monaco's clipboard keeps the key in editor text",
  'mod+a': "Select All in a results grid or Messages only (outputGridFocus || messagesFocus), both outside the editor; Monaco's Select All keeps the key in editor text",
  'cmd+e': "Search Options in the Options dialog only (optionsDialogFocus, a modal key); Monaco's find with selection keeps ⌘E in editor text",
  'cmd+i': "Properties in Object Explorer only (activePanel == 'explorer' && !textInputFocus && !searchHitsFocus): Monaco's suggestion trigger keeps ⌘I in editor text",
  'mod+f': "Find in Results in a results grid only (outputGridFocus): the grid is outside the editor, so Monaco's find keeps the key in editor text",
  'f3': "Find Next in Results in a results grid only (outputGridFocus); Monaco's next match keeps F3 in editor text",
  'shift+f3': "Find Previous in Results in a results grid only (outputGridFocus); Monaco's previous match keeps Shift+F3 in editor text",
  'cmd+g': "Find Next in Results on macOS in a results grid only (outputGridFocus); Monaco's ⌘G keeps it in editor text",
  'shift+cmd+g': "Find Previous in Results on macOS in a results grid only (outputGridFocus); Monaco's ⇧⌘G keeps it in editor text",
  'alt+down': "Filter Column Values in a results grid only (outputGridFocus), Excel's key for a column's filter list: the grid is outside the editor, so Monaco's hover scrolling and input history keep Alt+Down in editor text",
  'shift+escape': "Close Activity Monitor (activityMonitorFocus), SSMS's key: the monitor is outside the editor, so Monaco's Shift+Escape (closing a widget, leaving a snippet) keeps it in editor text"
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
  it('reviews every Monaco module start.tsx imports', () => {
    const source = readFileSync(join('src', 'renderer', 'src', 'start.tsx'), 'utf8')
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
    // Bridge rules are Varia's chords, which Monaco dispatches only because Varia registers them (registerEditorBridge).
    for (const rule of defaultRules(platform).filter(rule => rule.native && !rule.bridge && !commandDescriptor(rule.command).role)) expect(monaco.has(rule.chords.join(' ')), `${rule.command} ${rule.chords.join(' ')}`).toBe(true)
  })
  it.each(platforms)('bridge chords are free in Monaco on %s', platform => {
    // A Monaco contrib that binds one (linesOperations has Ctrl+K Ctrl+X) would race the bridge for it.
    const monaco = chordsByPlatform.get(platform)!
    expect(bridgeRules(platform).filter(rule => monaco.has(rule.chords.join(' '))).map(rule => `${rule.command} ${rule.chords.join(' ')} is bound by ${[...monaco.get(rule.chords.join(' '))!].join(', ')}`)).toEqual([])
  })
  it.each(platforms)('bridge chords start with the native chord prefix on %s', platform => {
    const rules = bridgeRules(platform)
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect([rule.chords.length, nativeChordPrefixes(platform).has(rule.chords[0])], rule.command).toEqual([2, true])
  })
  it("turns Monaco's own context menu off, so Shift+F10 and right-clicks show only the workbench's", () => {
    expect(readFileSync(join('src', 'renderer', 'src', 'editor', 'create-editor.ts'), 'utf8')).toMatch(/\bcontextmenu: false\b/)
    for (const platform of platforms) expect(workbenchRules(defaultRules(platform)).get('shift+f10')?.map(rule => [rule.command, rule.modal]), platform).toEqual([['workbench.showContextMenu', true]])
  })
  it('leaves Ctrl+R and ⌘R to the results pane toggle: Monaco binds neither', () => {
    for (const platform of platforms) {
      const chord = platform === 'darwin' ? 'meta+r' : 'ctrl+r'
      expect(chordsByPlatform.get(platform)!.has(chord), platform).toBe(false)
      expect(workbenchRules(defaultRules(platform)).get(chord)?.map(rule => rule.command), platform).toEqual(['view.toggleResultsPane'])
      expect(chordsByPlatform.get(platform)!.has(platform === 'darwin' ? 'shift+meta+r' : 'ctrl+shift+r'), platform).toBe(false)
      expect(workbenchRules(defaultRules(platform)).get(platform === 'darwin' ? 'shift+meta+r' : 'ctrl+shift+r')?.map(rule => rule.command), platform).toEqual(['edit.refreshIntelliSense'])
    }
  })
})

/**
 * Lane H (remapping Monaco's own keys) rests on these: Monaco 0.57's public `editor.addKeybindingRules` adds rules at
 * runtime, its Disposable takes exactly them away again, and a `-command` rule unbinds a default. Each check resolves
 * keys through Monaco's real StandaloneKeybindingService, as a key press in the editor would.
 */
describe('Monaco runtime keybinding rules', () => {
  let loaded: LoadedMonaco
  beforeAll(async () => { loaded = await loadMonaco() }, 60000)

  /** The command Monaco would run for `keybinding` (one chord) with `context` keys set, or undefined. */
  function press(keybinding: number, context: Readonly<Record<string, boolean>>): string | undefined {
    const { services, internals } = loaded
    const [chord] = internals.decodeKeybinding(keybinding, internals.os)!.chords
    const node = document.createElement('div'), scoped = services.contextKey.createScoped(node)
    try {
      for (const [key, value] of Object.entries(context)) scoped.createKey(key, value)
      const result = services.keybinding.softDispatch({ ...chord }, node)
      return result.kind === 2 ? result.commandId : undefined
    } finally { scoped.dispose() }
  }
  /** Every key Monaco currently binds to `command`, as labels in its own format. */
  const keysOf = (command: string): string[] => (loaded.services.keybinding.getKeybindings() as { command: string; resolvedKeybinding?: { getUserSettingsLabel(): string } }[])
    .filter(item => item.command === command && item.resolvedKeybinding).map(item => item.resolvedKeybinding!.getUserSettingsLabel()).sort()
  const editor = { editorFocus: true, editorTextFocus: true, textInputFocus: true }

  it('starts from the defaults', () => {
    const { KeyMod, KeyCode } = loaded.monaco
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
    expect(press(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, editor)).toBeUndefined()
    // The checks below add Ctrl/⌘+Alt+J, so it must be free on every platform (⌘⌥F, say, is Replace on macOS).
    for (const platform of platforms) {
      const free = platform === 'darwin' ? 'alt+meta+j' : 'ctrl+alt+j'
      expect(monacoKeyRules.some(rule => rule.keys[platform].some(chords => chords.join(' ') === free)), platform).toBe(false)
    }
    expect(keysOf('cancelSelection')).toEqual(['escape', 'shift+escape'])
  })

  it('triggers suggestions and lets the visible widget handle navigation, acceptance and dismissal', () => {
    const { KeyMod, KeyCode } = loaded.monaco
    const control = loaded.internals.os === 2 ? KeyMod.WinCtrl : KeyMod.CtrlCmd
    expect(press(control | KeyCode.Space, { ...editor, editorHasCompletionItemProvider: true })).toBe('editor.action.triggerSuggest')
    const suggestions = { ...editor, suggestWidgetVisible: true, suggestWidgetHasFocusedSuggestion: true, suggestWidgetMultipleSuggestions: true }
    expect(press(KeyCode.DownArrow, suggestions)).toBe('selectNextSuggestion')
    expect(press(KeyCode.Tab, suggestions)).toBe('acceptSelectedSuggestion')
    expect(press(KeyCode.Escape, suggestions)).toBe('hideSuggestWidget')
  })

  it('adds a rule and disposing it restores the default', () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco, before = keysOf('actions.find')
    const added = api.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, command: 'actions.find', when: 'editorFocus' }])
    expect(press(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, editor)).toBe('actions.find')
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
    expect(keysOf('actions.find')).toHaveLength(before.length + 1)
    added.dispose()
    expect(press(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, editor)).toBeUndefined()
    expect(keysOf('actions.find')).toEqual(before)
    // A second dispose is harmless.
    added.dispose()
    expect(keysOf('actions.find')).toEqual(before)
  })

  it("a `-command` rule with no key unbinds all of a default's keys until it is disposed", () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco, before = keysOf('actions.find')
    // keybinding 0 decodes to no key: a removal of every key the command has.
    const removed = api.addKeybindingRules([{ keybinding: 0, command: '-actions.find' }])
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBeUndefined()
    expect(keysOf('actions.find')).toEqual([])
    removed.dispose()
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
    expect(keysOf('actions.find')).toEqual(before)
  })

  it('a `-command` rule with a key unbinds only that key', () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco
    const removed = api.addKeybindingRules([{ keybinding: KeyMod.Shift | KeyCode.Escape, command: '-cancelSelection' }])
    expect(keysOf('cancelSelection')).toEqual(['escape'])
    expect(press(KeyMod.Shift | KeyCode.Escape, { ...editor, editorHasSelection: true })).toBeUndefined()
    expect(press(KeyCode.Escape, { ...editor, editorHasSelection: true })).toBe('cancelSelection')
    removed.dispose()
    expect(keysOf('cancelSelection')).toEqual(['escape', 'shift+escape'])
  })

  it('a remap is one call (remove the default, add the new key) and one dispose undoes both', () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco
    const remap = api.addKeybindingRules([
      { keybinding: KeyMod.CtrlCmd | KeyCode.KeyF, command: '-actions.find' },
      { keybinding: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, command: 'actions.find', when: 'editorFocus || editorIsOpen' }
    ])
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBeUndefined()
    expect(press(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, editor)).toBe('actions.find')
    remap.dispose()
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
    expect(press(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, editor)).toBeUndefined()
  })

  it("a removal matches a default only when its `when` is absent or implied by the default's", () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco
    // actions.find's default is `editorFocus || editorIsOpen`: a narrower removal clause leaves it bound, so lane H must
    // remove with no `when` or with the default's own clause (monacoKeyRules has it).
    const narrower = api.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyCode.KeyF, command: '-actions.find', when: 'editorTextFocus' }])
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
    narrower.dispose()
    const exact = api.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyCode.KeyF, command: '-actions.find', when: monacoRuleWhen(monacoKeyRules.find(rule => rule.command === 'actions.find')!, 'win32') }])
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBeUndefined()
    exact.dispose()
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
  })

  it("disposing registrations out of order removes only each one's own rules", () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco
    const first = api.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, command: 'actions.find', when: 'editorFocus' }])
    const second = api.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyCode.KeyF, command: '-actions.find' }])
    first.dispose()
    expect(press(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyJ, editor)).toBeUndefined()
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBeUndefined()
    second.dispose()
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
  })

  it('a rule for another command on a default key wins over the default while it lasts', () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco
    const command = api.registerCommand('varia.test.find', () => undefined)
    const shadow = api.addKeybindingRules([{ keybinding: KeyMod.CtrlCmd | KeyCode.KeyF, command: 'varia.test.find', when: 'editorTextFocus' }])
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('varia.test.find')
    // Outside its `when` the default still answers.
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, { editorFocus: true })).toBe('actions.find')
    shadow.dispose()
    command.dispose()
    expect(press(KeyMod.CtrlCmd | KeyCode.KeyF, editor)).toBe('actions.find')
  })

  it('removes and restores a two-part default chord', () => {
    const { KeyMod, KeyCode, editor: api } = loaded.monaco
    const chord = KeyMod.chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyC), before = keysOf('editor.action.addCommentLine')
    expect(before).toHaveLength(1)
    const removed = api.addKeybindingRules([{ keybinding: chord, command: '-editor.action.addCommentLine' }])
    expect(keysOf('editor.action.addCommentLine')).toEqual([])
    removed.dispose()
    expect(keysOf('editor.action.addCommentLine')).toEqual(before)
  })
})

// Regenerate after a Monaco upgrade or a change to start.tsx's Monaco imports: npx vitest run tests/monaco-keybindings.test.ts -u
describe('generated Monaco key table', () => {
  let loaded: LoadedMonaco, loads: Record<Platform, LoadedMonaco>
  beforeAll(async () => {
    loaded = await loadMonaco()
    // One at a time: each load fakes process.platform while Monaco's modules evaluate.
    loads = {} as Record<Platform, LoadedMonaco>
    for (const platform of platforms) loads[platform] = await loadMonacoFor(platform)
  }, 120000)

  it('keeps src/shared/commands/monaco-keys.generated.ts in sync with the installed Monaco', async () => {
    await expect(renderMonacoKeys(monacoKeyRows(loads))).toMatchFileSnapshot('../src/shared/commands/monaco-keys.generated.ts')
  })
  it('lists the editor keys the Shortcuts page shows as Editor rows', () => {
    const key = (command: string, platform: Platform) => monacoKeyRules.filter(rule => rule.command === command).flatMap(rule => rule.keys[platform].map(chords => chords.join(' ')))
    expect(key('actions.find', 'win32')).toEqual(['ctrl+f'])
    expect(key('actions.find', 'darwin')).toEqual(['meta+f'])
    expect(key('editor.action.startFindReplaceAction', 'win32')).toEqual(['ctrl+h'])
    expect(key('editor.action.startFindReplaceAction', 'darwin')).toEqual(['alt+meta+f'])
    expect(key('editor.action.addCommentLine', 'linux')).toEqual(['ctrl+k ctrl+c'])
    expect(key('cursorColumnSelectLeft', 'linux')).toEqual([])
    expect(monacoKeyRules.find(rule => rule.command === 'actions.find')).toMatchObject({ title: 'Find', when: 'editorFocus || editorIsOpen' })
    expect(monacoKeyRules.find(rule => rule.command === 'cursorEnd')?.args).toEqual({ sticky: false })
  })
  it("records each platform's clause where Monaco folds the OS into it", () => {
    // wordOperations guards its keys with !(accessibilityModeEnabled && isWindows), which Monaco folds as it loads.
    const rule = monacoKeyRules.find(rule => rule.command === 'cursorWordLeft')!
    expect(platforms.map(platform => monacoRuleWhen(rule, platform))).toEqual(['textInputFocus && !accessibilityModeEnabled', 'textInputFocus', 'textInputFocus'])
    expect([loads.win32.internals.os, loads.linux.internals.os, loads.darwin.internals.os]).toEqual([1, 3, 2])
  })
  it('loads Monaco as the sandboxed renderer does, on its web branch', () => {
    for (const platform of platforms) expect(loads[platform].internals, platform).toMatchObject({ isWeb: true, isNative: false })
    expect(loaded.internals).toMatchObject({ isWeb: true, isNative: false })
    // In a browser Monaco binds no Cut, Copy or Paste keys (the page's own roles take them), so lane H must not list them.
    for (const command of ['editor.action.clipboardCutAction', 'editor.action.clipboardCopyAction', 'editor.action.clipboardPasteAction']) {
      for (const platform of platforms) expect(loads[platform].rules.some(rule => rule.id === command), `${command} on ${platform}`).toBe(false)
      expect(monacoKeyRules.some(rule => rule.command === command), command).toBe(false)
    }
  })
  it('leaves out keys for widgets Varia never opens and keys inside Monaco widgets', () => {
    const commands = new Set(monacoKeyRules.map(rule => rule.command))
    for (const command of ['quickInput.accept', 'acceptSelectedCodeAction', 'editor.action.scrollUpHover', 'editor.action.revealDefinition', 'goToNextReference', 'jumpToNextSnippetPlaceholder', 'history.showNext']) {
      expect(loaded.rules.some(rule => rule.id === command), `Monaco still registers ${command}`).toBe(true)
      expect(commands.has(command), command).toBe(false)
    }
    // Every omitted context key names one that some Monaco rule uses, so the list cannot go stale.
    const clauses = loaded.rules.map(rule => rule.when?.serialize() ?? '')
    for (const key of Object.keys(omittedContextKeys)) expect(clauses.some(clause => clause.split(/ \|\| | && /).includes(key)), key).toBe(true)
  })
  it.each(platforms)('agrees with the source parser on %s', platform => {
    // The parser over-reports (platform blocks apply everywhere), so every generated key must be among its chords.
    const parsed = chordsByPlatform.get(platform)!
    for (const rule of monacoKeyRules) for (const chords of rule.keys[platform]) expect(parsed.has(chords.join(' ')), `${rule.command} ${chords.join(' ')}`).toBe(true)
  })
})
