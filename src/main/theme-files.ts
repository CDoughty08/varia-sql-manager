import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProblem, isReservedThemeId, parseThemeFile, parseThemeSource, quote, themeIdFromFileName, themeLimits } from '../shared/theme/format'
import { buildThemeJsonSchema } from '../shared/theme/schema'
import type { ThemeParseResult, ThemeProblem, ThemeProblemCode } from '../shared/theme/types'
import { readRegularFile } from './json-file'

export const themesFolderName = 'themes'
export const schemaFileName = 'varia-theme.schema.json'
const schemaBytesLimit = 1024 * 1024
const maxStarterFiles = 99

/** A theme file found in the folder, keyed by its lowercase id; duplicate ids yield one unusable entry. */
export interface ThemeFile { id: string; fileName: string; result: ThemeParseResult }
/** `problems` covers the folder itself and files that never get an id (bad or reserved names, the file cap). */
export interface ThemeScan { themes: ThemeFile[]; problems: ThemeProblem[]; files: number }
/** A failure whose message is a fixed sentence fit for the theme notice; other errors only ever show their code. */
export class ThemeActionError extends Error {}

const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown error'
}
const failure = (fileName: string, code: ThemeProblemCode, message: string): ThemeParseResult => ({ theme: null, problems: [createProblem(code, fileName, '', message)], problemsOmitted: 0 })
const notRegular = (fileName: string) => failure(fileName, 'E_READ', 'The theme is not a regular file. Varia does not follow links or read folders; copy the theme file itself into the themes folder.')
const byName = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
/** The entries the scan counts toward its file cap, valid names or not; links and folders too, so they can be reported. */
const isThemeEntry = (entry: Dirent) => entry.name.toLowerCase().endsWith('.json') && entry.name !== schemaFileName

/**
 * Lists `<dir>/*.json` and reads the files whose id passes `include` (all by default). Only regular files are read: a
 * symbolic link or folder with a theme's name becomes an unusable theme that says so, never a silent omission (a
 * linked theme from a dotfiles setup would otherwise read as missing). At most 64 entries, sorted by name, are considered.
 */
export async function scanThemes(dir: string, include: (id: string) => boolean = () => true): Promise<ThemeScan> {
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
    if (errorCode(error) === 'ENOENT') return { themes: [], problems: [], files: 0 }
    return { themes: [], problems: [createProblem('E_READ', themesFolderName, '', `The themes folder could not be read (${errorCode(error)}).`)], files: 0 }
  }
  const names = entries.filter(isThemeEntry).map(entry => entry.name).sort(byName)
  const problems: ThemeProblem[] = []
  const skipped = names.length - themeLimits.files
  if (skipped > 0) problems.push(createProblem('W_TOO_MANY_FILES', names[themeLimits.files], '', `Only the first ${themeLimits.files} theme files by name are loaded; ${skipped} ${skipped === 1 ? 'file was' : 'files, from this one on, were'} skipped.`))
  const files = names.slice(0, themeLimits.files), byId = new Map<string, string[]>()
  for (const fileName of files) {
    const id = themeIdFromFileName(fileName)
    // Bad and reserved names are rejected before any content is read; parseThemeFile owns their messages.
    if (id === undefined || isReservedThemeId(id)) problems.push(...parseThemeFile(undefined, fileName).problems)
    else byId.set(id, [...byId.get(id) ?? [], fileName])
  }
  const themes = await Promise.all([...byId].filter(([id]) => include(id)).map(async ([id, sameId]): Promise<ThemeFile> => sameId.length === 1
    ? { id, fileName: sameId[0], result: await readTheme(dir, sameId[0]) }
    : { id, fileName: sameId[0], result: { theme: null, problems: sameId.map(fileName => createProblem('E_DUPLICATE_ID', fileName, '', `${sameId.length} files have the theme id ${quote(id)} (ids ignore case); rename all but one.`)), problemsOmitted: 0 } }))
  return { themes, problems, files: files.length }
}

/**
 * Reads one theme file without following links, never more than the size limit plus one byte, then parses it. The
 * opened file must be the one lstat saw, which also holds on Windows, where open() cannot refuse a link.
 */
export async function readTheme(dir: string, fileName: string): Promise<ThemeParseResult> {
  const path = join(dir, fileName)
  let bytes: Buffer | undefined
  try {
    const seen = await lstat(path, { bigint: true })
    if (!seen.isFile()) return notRegular(fileName)
    bytes = await readRegularFile(path, themeLimits.fileBytes, { followLinks: false, expect: seen })
  } catch (error) { return failure(fileName, 'E_READ', `The file could not be read (${errorCode(error)}).`) }
  return bytes ? parseThemeSource(bytes, fileName) : notRegular(fileName)
}

/**
 * Writes the Create Custom Theme starter to the first free `custom-theme[-n].json`. Existing files are never replaced,
 * a name whose id another file already has (ids ignore case) is skipped, and a folder already at the scan's file cap
 * is refused, so the scan that follows always loads the new file.
 */
export async function writeStarterTheme(dir: string, theme: unknown): Promise<string> {
  const text = JSON.stringify(theme, null, 2) + '\n'
  const entries = await readdir(dir, { withFileTypes: true })
  if (entries.filter(isThemeEntry).length >= themeLimits.files) throw new ThemeActionError(`The themes folder already has ${themeLimits.files} theme files, the most Varia loads; remove one before creating another.`)
  const taken = new Set(entries.map(entry => entry.name.toLowerCase()))
  for (let index = 1; index <= maxStarterFiles; index++) {
    const fileName = index === 1 ? 'custom-theme.json' : `custom-theme-${index}.json`
    if (taken.has(fileName)) continue
    try { await writeFile(join(dir, fileName), text, { flag: 'wx' }); return fileName }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
  }
  throw new ThemeActionError(`custom-theme.json through custom-theme-${maxStarterFiles}.json already exist; rename or remove some of them first.`)
}

let schemaText: string | undefined
/**
 * Writes `varia-theme.schema.json` for offline autocompletion, only when its content differs. Returns whether it wrote.
 * It renames once, without the retries preference saves get on Windows: the schema is optional, and a path Windows
 * refuses to replace (a folder, a read-only file) must not hold up Open Themes Folder.
 */
export async function writeSchemaFile(dir: string): Promise<boolean> {
  schemaText ??= JSON.stringify(buildThemeJsonSchema(), null, 2) + '\n'
  const path = join(dir, schemaFileName), bytes = Buffer.from(schemaText)
  try {
    const current = await readRegularFile(path, schemaBytesLimit, { followLinks: false })
    if (current?.equals(bytes)) return false
  } catch { /* Missing or unreadable: replaced below. */ }
  // A new file renamed over the path replaces a link there instead of writing through it.
  const temporary = join(dir, `.varia-${randomUUID()}.tmp`)
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
  return true
}
