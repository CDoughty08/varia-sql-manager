// Loads the real Monaco the renderer loads (in a happy-dom test) and renders src/shared/commands/monaco-keys.generated.ts
// from its default keybinding rules. Monaco resolves each rule for the running OS as it registers it, so the loader
// wraps the registry first and keeps every rule's win, linux and mac variants.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { vi } from 'vitest'
import { monacoKeyCodes } from '../../src/renderer/src/editor/keybinding-bridge'
import { platforms, toPlatform, type Platform } from '../../src/shared/commands/keybindings'

// The Monaco modules start.tsx imports. Adding a contrib changes Monaco's keys, so it must be reviewed here.
export const reviewedImports = [
  'monaco-editor/editor/editor.api.js',
  'monaco-editor/languages/definitions/sql/register.js',
  'monaco-editor/languages/definitions/xml/register.js',
  'monaco-editor/editor/contrib/find/browser/findController.js',
  'monaco-editor/editor/contrib/clipboard/browser/clipboard.js',
  'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js',
  'monaco-editor/editor/contrib/comment/browser/comment.js',
  'monaco-editor/editor/contrib/snippet/browser/snippetController2.js',
  'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js',
  'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js',
  'monaco-editor/editor/contrib/hover/browser/hoverContribution.js',
  'monaco-editor/editor/contrib/suggest/browser/suggestController.js',
  'monaco-editor/features/codicon/register.js'
]

interface PlatformKeys { readonly primary?: number; readonly secondary?: readonly number[] }
interface RawRule extends PlatformKeys {
  readonly id: string
  readonly args?: unknown
  readonly when?: { serialize(): string }
  readonly win?: PlatformKeys
  readonly linux?: PlatformKeys
  readonly mac?: PlatformKeys
}
interface KeyChord { readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean; readonly metaKey: boolean; readonly keyCode: number }
interface Internals {
  readonly decodeKeybinding: (keybinding: number, os: number) => { readonly chords: readonly KeyChord[] } | null
  readonly titles: ReadonlyMap<string, string>
  /** The OperatingSystem Monaco detected, which its keybinding service resolves keys for. */
  readonly os: number
  /** Monaco's host branch: the renderer has no `process`, so web, not native. */
  readonly isWeb: boolean
  readonly isNative: boolean
}
export interface LoadedMonaco {
  readonly monaco: typeof Monaco
  /** Every default keybinding rule Monaco registered while the reviewed modules loaded, as registered. */
  readonly rules: readonly RawRule[]
  readonly internals: Internals
  /** Monaco's standalone services, for the runtime keybinding checks. */
  readonly services: { readonly keybinding: any; readonly contextKey: any }
}

const load = (specifier: string) => import(/* @vite-ignore */ specifier) as Promise<any>
/** Chromium's user agent per platform, as Electron's renderer reports it (Monaco reads only the OS words). */
export const rendererUserAgents: Readonly<Record<Platform, string>> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
}
/** Loads Monaco once per test file, as the renderer would on the running OS. Nothing may import Monaco's registry first. */
export function loadMonaco(): Promise<LoadedMonaco> {
  return loadMonacoFor(toPlatform(process.platform))
}
const loadedFor = new Map<Platform, Promise<LoadedMonaco>>()
let loads: Promise<unknown> = Promise.resolve()
/**
 * A Monaco loaded as Varia's renderer loads it on `platform`. The renderer is sandboxed and has no `process`, so Monaco's
 * platform.js takes its web branch and reads the OS from `navigator.userAgent`; that branch decides more than the OS
 * (the clipboard contrib binds Cut, Copy and Paste keys only on a native host, not in a browser). So while each load's
 * modules evaluate, `process.versions.node` is hidden and the user agent is the platform's. Monaco folds OS constants
 * into `when` clauses as it loads (wordOperations adds `!accessibilityModeEnabled` only on Windows), so each platform
 * gets its own load, one at a time, after a reset of the module cache.
 */
export function loadMonacoFor(platform: Platform): Promise<LoadedMonaco> {
  let instance = loadedFor.get(platform)
  if (!instance) {
    const first = loadedFor.size === 0
    instance = loads.then(async () => {
      if (!first) vi.resetModules()
      return await asRenderer(platform, loadInstance)
    })
    loads = instance.catch(() => undefined)
    loadedFor.set(platform, instance)
  }
  return instance
}
async function asRenderer<T>(platform: Platform, run: () => Promise<T>): Promise<T> {
  const versions = Object.getOwnPropertyDescriptor(process, 'versions')!
  const agent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
  Object.defineProperty(process, 'versions', { ...versions, value: { ...process.versions, node: undefined } })
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => rendererUserAgents[platform] })
  try { return await run() } finally {
    Object.defineProperty(process, 'versions', versions)
    if (agent) Object.defineProperty(navigator, 'userAgent', agent)
    else delete (navigator as { userAgent?: string }).userAgent
  }
}
async function loadInstance(): Promise<LoadedMonaco> {
  const { KeybindingsRegistry } = await load('monaco-editor/platform/keybinding/common/keybindingsRegistry.js')
  if (KeybindingsRegistry.getDefaultKeybindings().length) throw new Error('Monaco registered keybindings before loadMonaco wrapped its registry.')
  const rules: RawRule[] = [], register = KeybindingsRegistry.registerKeybindingRule
  // registerCommandAndKeybindingRule calls this method too, so one wrapper sees every rule.
  KeybindingsRegistry.registerKeybindingRule = function (rule: RawRule) { rules.push(rule); return register.call(this, rule) }
  let monaco: typeof Monaco
  try {
    monaco = await load(reviewedImports[0])
    for (const specifier of reviewedImports.slice(1)) await load(specifier)
  } finally {
    KeybindingsRegistry.registerKeybindingRule = register
  }
  const [{ decodeKeybinding }, { OS, isWeb, isNative }, { EditorExtensionsRegistry }, { MenuRegistry }, { StandaloneServices }, { IKeybindingService }, { IContextKeyService }] = await Promise.all([
    load('monaco-editor/base/common/keybindings.js'), load('monaco-editor/base/common/platform.js'), load('monaco-editor/editor/browser/editorExtensions.js'), load('monaco-editor/platform/actions/common/actions.js'),
    load('monaco-editor/editor/standalone/browser/standaloneServices.js'), load('monaco-editor/platform/keybinding/common/keybinding.js'),
    load('monaco-editor/platform/contextkey/common/contextkey.js')
  ])
  const titles = new Map<string, string>()
  for (const action of EditorExtensionsRegistry.getEditorActions() as { id: string; label: string }[]) titles.set(action.id, action.label)
  for (const rule of rules) {
    const title = MenuRegistry.getCommand(rule.id)?.title
    if (!titles.has(rule.id) && title) titles.set(rule.id, typeof title === 'string' ? title : title.value)
  }
  return {
    monaco: monaco!, rules, internals: { decodeKeybinding, titles, os: OS, isWeb, isNative },
    services: { keybinding: StandaloneServices.get(IKeybindingService), contextKey: StandaloneServices.get(IContextKeyService) }
  }
}

/** Monaco's OperatingSystem enum. */
const operatingSystems: Readonly<Record<Platform, number>> = { win32: 1, darwin: 2, linux: 3 }
const keyNameByCode = new Map(Object.entries(monacoKeyCodes).map(([name, code]) => [code, name]))

/** KeybindingsRegistryImpl.bindToCurrentPlatform for `platform`: a platform block replaces primary and secondary. */
function platformKeys(rule: RawRule, platform: Platform): readonly number[] {
  const block = (platform === 'win32' ? rule.win : platform === 'darwin' ? rule.mac : rule.linux) ?? rule
  return [block.primary ?? 0, ...(block.secondary ?? [])].filter(keybinding => keybinding !== 0)
}
function toChords(keybinding: number, platform: Platform, internals: Internals, command: string): string[] {
  const decoded = internals.decodeKeybinding(keybinding, operatingSystems[platform])
  if (!decoded) throw new Error(`${command}: Monaco keybinding ${keybinding} does not decode.`)
  return decoded.chords.map(chord => {
    const key = keyNameByCode.get(chord.keyCode)
    // A key the catalogue cannot name (a numpad key, say) needs keyNames and the bridge's table extended first.
    if (key === undefined) throw new Error(`${command}: Monaco key code ${chord.keyCode} has no Varia key name.`)
    return [chord.ctrlKey && 'ctrl', chord.shiftKey && 'shift', chord.altKey && 'alt', chord.metaKey && 'meta', key].filter(Boolean).join('+')
  })
}

/**
 * Context keys whose rules the Shortcuts page leaves out, each with its reason. A rule is left out when every
 * alternative of its `when` requires one of these keys to be true.
 */
export const omittedContextKeys: Readonly<Record<string, string>> = {
  inQuickInput: "Monaco's quick input: Varia's palette is its own",
  historyNavigationWidgetFocus: "the find widget's input history (Up and Down inside its input)",
  findInputFocussed: "Enter and Shift+Enter inside the find widget's input",
  replaceInputFocussed: "Enter inside the find widget's replace input",
  codeActionMenuVisible: 'keys inside the code action menu, which no Varia language provider opens',
  editorHoverFocused: 'keys inside a focused hover',
  listFocus: 'keys inside the references list',
  inReferenceSearchEditor: 'the references peek, which no Varia language provider opens',
  referenceSearchVisible: 'the references peek, which no Varia language provider opens',
  editorHasDefinitionProvider: 'Varia registers no definition provider',
  editorHasImplementationProvider: 'Varia registers no implementation provider',
  editorHasReferenceProvider: 'Varia registers no reference provider',
  editorHasTypeDefinitionProvider: 'Varia registers no type definition provider',
  hasSymbols: 'symbol navigation, which no Varia language provider fills',
  cancellableOperation: 'Escape while a language provider request runs',
  messageVisible: "Escape closing the editor's inline message",
  markersNavigationVisible: 'Escape closing the problems peek: the SQL language reports no markers',
  inSnippetMode: 'Tab, Shift+Tab and Escape while a snippet is active',
  editorColumnSelection: 'Shift+arrows while column selection mode is on'
}
function omitted(when: string | undefined): boolean {
  if (!when) return false
  return when.split(' || ').every(alternative => alternative.split(' && ').some(term => Object.hasOwn(omittedContextKeys, term)))
}

export interface MonacoKeyRow {
  readonly command: string
  readonly title?: string
  /** Monaco's clause, or each platform's where they differ (null: none there). */
  readonly when?: string | Readonly<Record<Platform, string | null>>
  readonly args?: unknown
  readonly keys: Readonly<Record<Platform, readonly (readonly string[])[]>>
}
/** `command#n` for each rule: the nth rule Monaco registered for that command. */
function occurrences(rules: readonly RawRule[]): string[] {
  const seen = new Map<string, number>()
  return rules.map(rule => { const n = seen.get(rule.id) ?? 0; seen.set(rule.id, n + 1); return `${rule.id}#${n}` })
}
/**
 * One row per default rule that is bound on some platform and not omitted on all, in Monaco's registration order. Each
 * platform's keys and clause come from its own load; rules are matched across loads by command and occurrence.
 */
export function monacoKeyRows(loads: Readonly<Record<Platform, Pick<LoadedMonaco, 'rules' | 'internals'>>>): MonacoKeyRow[] {
  const base = loads[platforms[0]].rules, ids = occurrences(base)
  for (const platform of platforms) {
    const other = occurrences(loads[platform].rules)
    if (other.length !== ids.length || other.some((id, index) => id !== ids[index])) throw new Error(`Monaco registers different rules on ${platform}; match them by more than command and occurrence.`)
  }
  const rows: MonacoKeyRow[] = []
  base.forEach((first, index) => {
    const keys = {} as Record<Platform, string[][]>, when = {} as Record<Platform, string | null>
    for (const platform of platforms) {
      const rule = loads[platform].rules[index], clause = rule.when?.serialize() || null
      when[platform] = clause
      keys[platform] = omitted(clause ?? undefined) ? [] : platformKeys(rule, platform).map(keybinding => toChords(keybinding, platform, loads[platform].internals, rule.id))
    }
    if (platforms.every(platform => keys[platform].length === 0)) return
    const clauses = new Set(platforms.map(platform => when[platform])), common = when[platforms[0]]
    const title = loads[platforms[0]].internals.titles.get(first.id)
    rows.push({
      command: first.id, ...(title ? { title } : {}), ...(clauses.size > 1 ? { when } : common ? { when: common } : {}),
      ...(first.args === undefined ? {} : { args: first.args }), keys
    })
  })
  return rows
}

/** A TypeScript literal in the repository's style: single quotes, no quoted keys that need none. */
function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, entry]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : literal(key)}: ${literal(entry)}`).join(', ')} }`
  return JSON.stringify(value)
}

export function renderMonacoKeys(rows: readonly MonacoKeyRow[]): string {
  const version = (JSON.parse(readFileSync(join('node_modules', 'monaco-editor', 'package.json'), 'utf8')) as { version: string }).version
  return [
    `// Generated from monaco-editor ${version} by tests/monaco-keybindings.test.ts (tests/fixtures/monaco-runtime.ts). Do not edit.`,
    '// Regenerate after a Monaco upgrade or a change to start.tsx\'s Monaco imports: npx vitest run tests/monaco-keybindings.test.ts -u',
    "import type { Platform } from './keybindings'",
    '',
    '/**',
    " * One of Monaco's default keybinding rules in the modules Varia's editor loads. `keys` lists each platform's",
    ' * keybindings in canonical chords (primary first); an empty list means the rule has no key there. `when` is Monaco\'s',
    " * own clause, or each platform's where Monaco builds them differently (null: none there; read it with `monacoRuleWhen`),",
    ' * and `args` the arguments its rule passes. Rules for widgets Varia never opens, or keys that act only inside a Monaco',
    ' * widget, are left out (`omittedContextKeys` in the generator).',
    ' */',
    'export interface MonacoKeyRule {',
    '  readonly command: string',
    '  readonly title?: string',
    '  readonly when?: string | Readonly<Record<Platform, string | null>>',
    '  readonly args?: unknown',
    '  readonly keys: Readonly<Record<Platform, readonly (readonly string[])[]>>',
    '}',
    '',
    `export const monacoKeysVersion = ${literal(version)}`,
    '',
    "/** The rule's `when` clause on `platform`, or undefined when it has none. */",
    'export function monacoRuleWhen(rule: MonacoKeyRule, platform: Platform): string | undefined {',
    "  return typeof rule.when === 'object' ? rule.when[platform] ?? undefined : rule.when",
    '}',
    '',
    'export const monacoKeyRules: readonly MonacoKeyRule[] = [',
    ...rows.map((row, index) => `  ${literal(row)}${index === rows.length - 1 ? '' : ','}`),
    ']',
    ''
  ].join('\n')
}
