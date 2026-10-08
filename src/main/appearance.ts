import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hexColor, nativeOverlay, opaqueHex } from '../shared/theme/color'
import { createProblem, defaultThemePreference, limitProblems, quote, starterTheme, themeIdFromFileName, themeLimits, themePreferencePatchSchema } from '../shared/theme/format'
import { builtinThemes } from '../shared/theme/palette'
import { resolveTheme } from '../shared/theme/resolve'
import type { ParsedTheme, ThemeMode, ThemePreference, ThemePreferencePatch, ThemeProblem, ThemeResolution, ThemeState, ThemeSummary, ThemeType } from '../shared/theme/types'
import { AppearanceStore } from './appearance-store'
import { scanThemes, ThemeActionError, themesFolderName, writeSchemaFile, writeStarterTheme, type ThemeFile, type ThemeScan } from './theme-files'

/** The part of Electron's `nativeTheme` the service uses, so tests can drive System mode. */
export interface NativeThemeLike { themeSource: ThemeMode; readonly shouldUseDarkColors: boolean }
/** Opaque `#rrggbb` only: Electron reads 8-digit hex as ARGB. */
export interface WindowChrome { backgroundColor: string; overlay: { color: string; symbolColor: string } }

interface CatalogEntry { summary: ThemeSummary; resolutions: Partial<Record<ThemeType, ThemeResolution>>; problems: ThemeProblem[]; problemsOmitted: number }

export const appearanceTimeout = 1500
const themeTypes: readonly ThemeType[] = ['dark', 'light']
const slotOf = (type: ThemeType) => type === 'dark' ? 'darkTheme' as const : 'lightTheme' as const
const typesOf = (theme: ParsedTheme): ThemeType[] => theme.type === 'dual' ? [...themeTypes] : [theme.type]
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
/** ' (EACCES)' for a file-system error; nothing else from an error reaches a notice. */
const detail = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : ''
}
const readOnly = new Set(['EROFS', 'EACCES', 'EPERM'])
/** A folder action's failure as a fixed sentence: its own message when it has one, otherwise `failed` and the code. */
const actionError = (error: unknown, failed: string) => error instanceof ThemeActionError ? error
  : new ThemeActionError(`${failed}${readOnly.has((error as NodeJS.ErrnoException | undefined)?.code ?? '') ? ' because the themes folder is not writable' : ''}${detail(error)}.`)
const builtinResolutions: Record<ThemeType, ThemeResolution> = { dark: resolveTheme([], 'dark'), light: resolveTheme([], 'light') }
const builtinEntries = themeTypes.map((type): CatalogEntry => ({
  summary: { ...builtinThemes[type], source: 'builtin', types: [type], usable: true, errors: 0, warnings: 0 }, resolutions: { [type]: builtinResolutions[type] }, problems: [], problemsOmitted: 0
}))

function userEntry(file: ThemeFile): CatalogEntry {
  const parsed = file.result.theme, resolutions: CatalogEntry['resolutions'] = {}
  const problems = [...file.result.problems]
  let resolved = !!parsed
  for (const type of parsed ? typesOf(parsed) : []) {
    try {
      const resolution = resolveTheme([parsed!], type)
      resolutions[type] = resolution
      problems.push(...resolution.problems)
    } catch {
      resolved = false
      problems.push(createProblem('E_FIELD', file.fileName, '', 'The theme could not be resolved.'))
    }
  }
  const unique = limitProblems(problems, Infinity).problems
  const errors = unique.filter(problem => problem.severity === 'error').length
  const usable = resolved && errors === 0
  return {
    summary: { id: file.id, name: parsed?.name ?? file.id, source: 'user', types: usable ? typesOf(parsed!) : [], usable, errors, warnings: unique.length - errors },
    resolutions: usable ? resolutions : {}, problems: unique.slice(0, themeLimits.problemsPerFile),
    problemsOmitted: file.result.problemsOmitted + Math.max(0, unique.length - themeLimits.problemsPerFile)
  }
}

/**
 * Owns the theme choice in the main process: loads `appearance.json` and the theme files, resolves the active theme,
 * drives `nativeTheme.themeSource`, and publishes a `ThemeState` whose revision grows only when its content changes.
 * Every mutation runs in order on one promise chain, and no public method lets a file or resolution failure escape
 * except `setPreference` (invalid choices) and the folder actions.
 */
export class AppearanceService {
  readonly folder: string
  private readonly store: AppearanceStore
  private readonly nativeTheme: NativeThemeLike
  private preference: ThemePreference = { ...defaultThemePreference }
  private catalogue = new Map<string, CatalogEntry>()
  private folderProblems: ThemeProblem[] = []
  private complete = false
  private loaded = false
  private writable = true
  /** The last choice was applied but not saved, so choosing it again retries the save. */
  private unsaved = false
  private message: string | undefined
  private noticeId = 0
  private current: ThemeState
  private fingerprint: string
  private listeners = new Set<(state: ThemeState) => void>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: { userData: string; nativeTheme: NativeThemeLike }) {
    this.folder = join(options.userData, themesFolderName)
    this.store = new AppearanceStore(join(options.userData, 'appearance.json'))
    this.nativeTheme = options.nativeTheme
    this.setCatalogue({ themes: [], problems: [], files: 0 })
    const state = this.compose()
    this.fingerprint = JSON.stringify(state)
    this.current = { revision: 0, ...state }
  }

  get state(): ThemeState { return this.current }

  /**
   * Reads the preference and only the selected theme files (one, or two in System mode). If that takes longer than
   * `timeout`, the built-in for the default mode is shown with a notice, and the result is applied when it arrives.
   */
  async initialize(timeout = appearanceTimeout): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const finished = await Promise.race([this.enqueue(() => this.load()).then(() => true, () => true), new Promise<boolean>(resolve => { timer = setTimeout(resolve, timeout, false) })])
    clearTimeout(timer)
    if (finished || this.loaded) return
    this.applySource()
    this.say(`Themes are taking longer than expected to load; ${builtinThemes[this.effectiveType()].name} is shown until they are ready.`)
    this.update()
  }

  /** Loads the full catalogue (the menu lists every theme), then publishes. */
  scan(): Promise<void> {
    return this.enqueue(async () => { await this.scanAll(); this.update() })
  }

  reload(): Promise<ThemeState> {
    return this.enqueue(async () => {
      const scan = await this.scanAll()
      // Only files counted in scan.files: the folder's own problems and the files past the cap are listed, not counted.
      const fileProblems = [...[...this.catalogue.values()].flatMap(entry => entry.problems), ...scan.problems.filter(problem => problem.code === 'E_FILE_NAME' || problem.code === 'E_RESERVED')]
      const troubled = new Set(fileProblems.map(problem => problem.file)).size
      this.say(scan.problems.some(problem => problem.file === themesFolderName) ? 'Reloaded 0 themes; the themes folder could not be read.'
        : `Reloaded ${plural(scan.files, 'theme', 'themes')}; ${troubled} ${troubled === 1 ? 'has' : 'have'} problems.`)
      this.update()
      return this.current
    })
  }

  /** Applies a validated patch; ids must name usable themes that support the slot's type. Persists explicit choices only. */
  async setPreference(value: unknown): Promise<ThemeState> {
    const patch = themePreferencePatchSchema.parse(value)
    return this.enqueue(async () => {
      if (!this.complete) { await this.scanAll(); this.update() }
      return this.choose(patch)
    })
  }

  /** Re-resolves after an OS appearance change; only System mode follows it, and `themeSource` is never assigned here. */
  systemChanged(): void {
    void this.enqueue(() => { if (this.preference.mode === 'system' && this.current.active.type !== this.effectiveType()) this.update() })
  }

  windowChrome(): WindowChrome {
    const active = this.current.active
    return { backgroundColor: opaqueHex(hexColor(active.colors['editor.background'])), overlay: nativeOverlay(active) }
  }

  /** Creates the themes folder and refreshes its schema file. Failures are `ThemeActionError`s with fixed messages. */
  async ensureFolder(): Promise<string> {
    try { await mkdir(this.folder, { recursive: true }) } catch (error) { throw actionError(error, 'The themes folder could not be created') }
    // The schema only gives editors completion, so a folder that cannot take it (read-only, locked) still opens.
    await writeSchemaFile(this.folder).catch(() => {})
    return this.folder
  }

  /**
   * Writes a starter seeded from the active theme, rescans, and selects it for the active type. Returns its path;
   * failures are `ThemeActionError`s with fixed messages.
   */
  createStarterTheme(): Promise<string> {
    return this.enqueue(async () => {
      try {
        const folder = await this.ensureFolder()
        const { type, resolution } = this.selection()
        const fileName = await writeStarterTheme(folder, starterTheme(type, (resolution ?? builtinResolutions[type]).palette))
        await this.scanAll()
        const id = themeIdFromFileName(fileName)!
        if (!this.catalogue.get(id)?.resolutions[type]) {
          this.update()
          throw new ThemeActionError(`${fileName} was created in the themes folder but could not be selected.`)
        }
        await this.choose(type === 'dark' ? { darkTheme: id } : { lightTheme: id })
        return join(folder, fileName)
      } catch (error) { throw actionError(error, 'The custom theme could not be created') }
    })
  }

  /** Shows a message in the theme notice until the next choice. */
  notify(message: string): Promise<void> {
    return this.enqueue(() => { this.say(message.slice(0, themeLimits.message)); this.update() })
  }

  onDidChange(listener: (state: ThemeState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(task)
    this.chain = next.catch(() => {})
    return next
  }

  private async load(): Promise<void> {
    // Everything is committed at the end, so a provisional state shown after a timeout never mixes old and new values.
    let preference: ThemePreference = { ...defaultThemePreference }, warning: string | undefined, writable = true
    try { ({ preference, warning } = await this.store.load()) }
    catch (error) {
      // An unreadable file may still hold the user's choice, so it is left alone rather than overwritten.
      writable = false
      warning = `Theme preferences could not be read${detail(error)}; the defaults are used and changes are not saved.`
    }
    const selected = new Set(themeTypes.filter(type => preference.mode === 'system' || preference.mode === type).map(type => preference[slotOf(type)]))
    const scan = await this.readFolder(id => selected.has(id))
    this.preference = preference
    this.writable = writable
    this.setCatalogue(scan)
    this.say(warning)
    this.loaded = true
    this.applySource()
    this.update()
  }

  private async readFolder(include?: (id: string) => boolean): Promise<ThemeScan> {
    try { return await scanThemes(this.folder, include) }
    catch (error) { return { themes: [], problems: [createProblem('E_READ', themesFolderName, '', `The themes folder could not be read${detail(error)}.`)], files: 0 } }
  }

  private async scanAll(): Promise<ThemeScan> {
    const scan = await this.readFolder()
    this.setCatalogue(scan)
    this.complete = true
    return scan
  }

  private async choose(patch: ThemePreferencePatch): Promise<ThemeState> {
    for (const type of themeTypes) {
      const id = patch[slotOf(type)]
      if (id !== undefined && !this.catalogue.get(id)?.resolutions[type]) throw new Error('Unknown or unusable theme.')
    }
    const previous = this.preference
    this.preference = { ...previous, ...patch }
    this.applySource()
    this.say(this.warningNotice(patch))
    this.update()
    if (!this.unsaved && JSON.stringify(this.preference) === JSON.stringify(previous)) return this.current
    const unsaved = (reason: string) => { this.unsaved = true; this.say([this.message, `The theme was applied but could not be saved${reason}.`].filter(Boolean).join(' ')) }
    if (!this.writable) unsaved(' because the preferences file could not be read')
    else {
      try { await this.store.save(this.preference); this.unsaved = false } catch (error) { unsaved(detail(error)) }
    }
    this.update()
    return this.current
  }

  /** Names the warnings of the themes a choice selects; a mode change is about the theme it makes active. */
  private warningNotice(patch: ThemePreferencePatch): string | undefined {
    const chosen = new Set([patch.darkTheme, patch.lightTheme].filter((id): id is string => id !== undefined))
    if (!chosen.size) {
      const { id, resolution } = this.selection()
      if (resolution) chosen.add(id)
    }
    const notices = [...chosen].map(id => this.catalogue.get(id)?.summary).filter(summary => summary?.source === 'user' && summary.warnings > 0)
      .map(summary => `${quote(summary!.name)} has ${plural(summary!.warnings, 'problem', 'problems')}; the affected entries use their defaults.`)
    return notices.join(' ') || undefined
  }

  /** An action's report for the notice; any non-empty one is a new notice, even when its text repeats the last. */
  private say(message: string | undefined): void {
    this.message = message
    if (message) this.noticeId++
  }

  private setCatalogue(scan: ThemeScan): void {
    this.catalogue = new Map(builtinEntries.map(entry => [entry.summary.id, entry]))
    for (const file of scan.themes) this.catalogue.set(file.id, userEntry(file))
    this.folderProblems = scan.problems
  }

  private applySource(): void {
    if (this.nativeTheme.themeSource !== this.preference.mode) this.nativeTheme.themeSource = this.preference.mode
  }

  private effectiveType(): ThemeType {
    return this.preference.mode === 'system' ? this.nativeTheme.shouldUseDarkColors ? 'dark' : 'light' : this.preference.mode
  }

  private selection() {
    const type = this.effectiveType(), id = this.preference[slotOf(type)], entry = this.catalogue.get(id)
    return { type, id, entry, resolution: entry?.resolutions[type] }
  }

  /** Selected themes' problems first, so the notice's first lines are about the theme the user chose. */
  private allProblems(): ThemeProblem[] {
    const selected = new Set(themeTypes.map(type => this.preference[slotOf(type)]))
    const entries = [...this.catalogue.values()].sort((a, b) => Number(selected.has(b.summary.id)) - Number(selected.has(a.summary.id)))
    return [...entries.flatMap(entry => entry.problems), ...this.folderProblems]
  }

  private compose(): Omit<ThemeState, 'revision'> {
    const { type, id, entry, resolution } = this.selection()
    const fallbackName = builtinThemes[type].name
    const fallback = !resolution
    const reason = !entry ? `The theme ${quote(id)} was not found in the themes folder`
      : !entry.summary.usable ? `The theme ${quote(entry.summary.name)} has errors and cannot be used`
      : `The theme ${quote(entry.summary.name)} has no ${type} variant`
    const notice = [this.message, fallback ? `${reason}; ${fallbackName} is used instead.` : undefined].filter(Boolean).join(' ')
    const problems = this.allProblems()
    const shown = problems.slice(0, themeLimits.problemsTotal)
    const omitted = [...this.catalogue.values()].reduce((sum, item) => sum + item.problemsOmitted, problems.length - shown.length)
    const themes = [...this.catalogue.values()].map(item => item.summary)
      .sort((a, b) => (a.source === b.source ? 0 : a.source === 'builtin' ? -1 : 1) || compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.id, b.id))
    return {
      preference: { ...this.preference }, active: (resolution ?? builtinResolutions[type]).theme, fallback, themes,
      problems: shown, problemsOmitted: omitted, ...(notice && { notice }), noticeId: this.noticeId
    }
  }

  private update(): void {
    const state = this.compose(), fingerprint = JSON.stringify(state)
    if (fingerprint === this.fingerprint) return
    this.fingerprint = fingerprint
    this.current = { revision: this.current.revision + 1, ...state }
    for (const listener of [...this.listeners]) {
      try { listener(this.current) } catch { /* One failing subscriber must not stop the others or the caller. */ }
    }
  }
}

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
