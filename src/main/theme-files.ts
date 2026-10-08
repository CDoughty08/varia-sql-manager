import { constants, type Dirent } from 'node:fs'
import { lstat, open, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProblem, isReservedThemeId, parseThemeFile, parseThemeSource, quote, themeIdFromFileName, themeLimits } from '../shared/theme/format'
import { buildThemeJsonSchema } from '../shared/theme/schema'
import type { ThemeParseResult, ThemeProblem, ThemeProblemCode } from '../shared/theme/types'
import { writeJsonAtomic } from './json-file'

export const themesFolderName = 'themes'
export const schemaFileName = 'varia-theme.schema.json'
const schemaBytesLimit = 1024 * 1024
const maxStarterFiles = 99

/** A theme file found in the folder, keyed by its lowercase id; duplicate ids yield one unusable entry. */
export interface ThemeFile { id: string; fileName: string; result: ThemeParseResult }
/** `problems` covers the folder itself and files that never get an id (bad or reserved names, the file cap). */
export interface ThemeScan { themes: ThemeFile[]; problems: ThemeProblem[]; files: number }

const errorCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown error'
}
const failure = (fileName: string, code: ThemeProblemCode, message: string): ThemeParseResult => ({ theme: null, problems: [createProblem(code, fileName, '', message)], problemsOmitted: 0 })
const byName = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
// Not following links at open() closes the gap between lstat and open; O_NONBLOCK keeps a swapped-in FIFO from hanging the read.
const readFlags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)

/**
 * Lists `<dir>/*.json` and reads the files whose id passes `include` (all by default). Only regular files are read:
 * symbolic links and folders are skipped. At most 64 files, sorted by name, are considered.
 */
export async function scanThemes(dir: string, include: (id: string) => boolean = () => true): Promise<ThemeScan> {
  let entries: Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (error) {
    if (errorCode(error) === 'ENOENT') return { themes: [], problems: [], files: 0 }
    return { themes: [], problems: [createProblem('E_READ', themesFolderName, '', `The themes folder could not be read (${errorCode(error)}).`)], files: 0 }
  }
  const names = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json') && entry.name !== schemaFileName).map(entry => entry.name).sort(byName)
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

/** Reads one theme file without following links, never more than the size limit plus one byte, then parses it. */
export async function readTheme(dir: string, fileName: string): Promise<ThemeParseResult> {
  const path = join(dir, fileName)
  let bytes: Uint8Array
  try {
    if (!(await lstat(path)).isFile()) return failure(fileName, 'E_READ', 'The theme is not a regular file; links and folders are not followed.')
    const file = await open(path, readFlags)
    try {
      const info = await file.stat()
      if (!info.isFile()) return failure(fileName, 'E_READ', 'The theme is not a regular file; links and folders are not followed.')
      const capacity = Math.min(info.size, themeLimits.fileBytes) + 1, buffer = Buffer.alloc(capacity)
      let length = 0
      while (length < capacity) {
        const { bytesRead } = await file.read(buffer, length, capacity - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      bytes = buffer.subarray(0, length)
    } finally { await file.close() }
  } catch (error) { return failure(fileName, 'E_READ', `The file could not be read (${errorCode(error)}).`) }
  return parseThemeSource(bytes, fileName)
}

/** Writes the Create Custom Theme starter to the first free `custom-theme[-n].json`; existing files are never replaced. */
export async function writeStarterTheme(dir: string, theme: unknown): Promise<string> {
  const text = JSON.stringify(theme, null, 2) + '\n'
  for (let index = 1; index <= maxStarterFiles; index++) {
    const fileName = index === 1 ? 'custom-theme.json' : `custom-theme-${index}.json`
    try { await writeFile(join(dir, fileName), text, { flag: 'wx' }); return fileName }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
  }
  throw new Error(`custom-theme.json through custom-theme-${maxStarterFiles}.json already exist; rename or remove some of them first.`)
}

let schemaText: string | undefined
/** Writes `varia-theme.schema.json` for offline autocompletion, only when its content differs. Returns whether it wrote. */
export async function writeSchemaFile(dir: string): Promise<boolean> {
  const schema = buildThemeJsonSchema()
  schemaText ??= JSON.stringify(schema, null, 2) + '\n'
  const path = join(dir, schemaFileName)
  try {
    const info = await lstat(path)
    if (info.isFile() && info.size === Buffer.byteLength(schemaText) && await readFile(path, 'utf8') === schemaText) return false
  } catch { /* Missing or unreadable: replaced below. */ }
  // The atomic rename replaces a link at this path instead of writing through it.
  await writeJsonAtomic(path, schema, schemaBytesLimit, 'The theme schema exceeds its size limit.')
  return true
}
