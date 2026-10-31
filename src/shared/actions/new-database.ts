// New Database without the DOM: the design OK and Script send, its rules (zod's superRefine, the document's field problems
// and NewDatabaseValidator.cs apply the same ones), SSMS's default names for the files, sanitised for the server's platform
// (critic A23), and the order of the statements after CREATE DATABASE. Erasable TypeScript, loadable by Node's type stripping.
import { actionLimits } from './catalog.ts'
import { afterReadOnlyProblem, collationPattern, optionDef, scopedConfigurationDefs, settableOptionKeys, tokenProblem, type Growth } from './database.ts'
import { folderPath, serverPathProblem, type ServerPathSeparator } from './files.ts'
import type { DatabasePropertiesModel } from './schema.ts'

export type NewFileType = 'rows' | 'log' | 'filestream'
export type NewFilegroupType = 'rows' | 'filestream' | 'memoryOptimized'
/**
 * One file: its logical name, type and filegroup (none for a log file), its size in MB (none for a FILESTREAM or
 * memory-optimized container, which grows as it needs), its autogrowth and maximum, the server folder it goes in, and its
 * file name there (a container's folder name), always explicit: the document fills in SSMS's default name.
 */
export interface NewDatabaseFile {
  readonly name: string
  readonly type: NewFileType
  readonly filegroup?: string
  readonly sizeMb?: number
  readonly growth: Growth
  readonly path: string
  readonly fileName: string
}
/** A filegroup: PRIMARY first. Read-Only and Autogrow All Files apply to rows filegroups; Default to rows and FILESTREAM ones. */
export interface NewDatabaseFilegroup {
  readonly name: string
  readonly type: NewFilegroupType
  readonly readOnly?: boolean
  readonly isDefault?: boolean
  readonly autogrowAllFiles?: boolean
}
export const containmentTypes = ['NONE', 'PARTIAL'] as const
export type ContainmentType = typeof containmentTypes[number]
/**
 * What OK and Script send (D1 §5.6): the owner (absent: the login that creates it), the files and filegroups, the collation
 * (absent: the server's), containment, ledger (SQL Server 2022 and later), and the options and scoped configurations that
 * differ from model, as tokens. The owner decision: Script writes only those, never every option as SSMS does.
 */
export interface NewDatabaseDesign {
  readonly owner?: string
  readonly files: readonly NewDatabaseFile[]
  readonly filegroups: readonly NewDatabaseFilegroup[]
  readonly collation?: string
  readonly containment: ContainmentType
  readonly ledger?: boolean
  readonly options: Readonly<Record<string, string>>
  readonly scoped: Readonly<Record<string, string>>
}
/**
 * What the New Database describe reads, in master: model as Database Properties reads it (a new database starts as a copy of
 * model: its files' sizes and growth, its options and scoped configurations), the instance's default data and log folders,
 * the server's collation, whether the login may create a database, master's compatibility level (the builder's OPENJSON
 * needs 130) and whether the server runs on Linux.
 */
export interface NewDatabaseModel {
  readonly model: DatabasePropertiesModel
  readonly dataPath: string
  readonly logPath: string
  readonly serverCollation: string
  /** CREATE ANY DATABASE (or CREATE DATABASE in master); unknown counts as yes, as the server decides. */
  readonly canCreate: boolean
  readonly masterLevel: number
  readonly linux: boolean
}

/** The options New Database sends as ALTER DATABASE after CREATE: every settable one but those CREATE itself writes. */
export const createOptionKeys: readonly string[] = ['collation', 'containmentType']
export const newDatabaseOptionKeys: readonly string[] = settableOptionKeys.filter(key => !createOptionKeys.includes(key))
export const newDatabaseScopedKeys: readonly string[] = scopedConfigurationDefs.filter(def => def.settable).map(def => def.key)
const systemDatabaseNames = ['master', 'model', 'msdb', 'tempdb']
export const primaryFilegroup = 'PRIMARY'

// --- Names (critic A23) ------------------------------------------------------------------------------------------------------

/** The separator a server path uses: a Linux path starts with /. */
export const separatorOf = (path: string): ServerPathSeparator => path.startsWith('/') ? '/' : '\\'
const windowsForbidden = /[\u0000-\u001f\\/:*?"<>|]/g
// ServerPath refuses * ? " < > | on every platform, so a Linux file name cannot hold them either.
const linuxForbidden = /[\u0000-\u001f/*?"<>|]/g
const brokenPairs = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const windowsReserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i
/**
 * A logical name made safe as a file name on the server's platform: characters the platform refuses (and control characters,
 * and halves of surrogate pairs) become _, and on Windows trailing dots and spaces (which it drops) become _ and a reserved
 * device name gets a leading _. A database named a\b gets the file a_b.mdf rather than a path into a folder b.
 */
export function sanitiseFileName(name: string, separator: ServerPathSeparator): string {
  let text = name.replace(separator === '\\' ? windowsForbidden : linuxForbidden, '_').replace(brokenPairs, '_')
  if (separator === '\\') {
    text = text.replace(/[. ]+$/, trail => '_'.repeat(trail.length))
    if (windowsReserved.test(text)) text = '_' + text
  }
  return text === '' || text === '.' || text === '..' ? '_' : text
}
/** SSMS's file name for a file: its logical name with .mdf (the primary data file), .ndf (another data file) or .ldf (a log
 *  file); a FILESTREAM or memory-optimized container is a folder named after it. */
export function defaultFileName(logical: string, type: NewFileType, primary: boolean, separator: ServerPathSeparator): string {
  const extension = type === 'log' ? '.ldf' : type === 'filestream' ? '' : primary ? '.mdf' : '.ndf'
  // The extension always fits: a long name is cut first, never mid surrogate pair.
  let stem = sanitiseFileName(logical, separator)
  const room = actionLimits.serverPath - extension.length
  if (stem.length > room) stem = stem.slice(0, /[\uD800-\uDBFF]/.test(stem[room - 1]) ? room - 1 : room)
  return stem + extension
}
/** Why a file name cannot be one on the server's platform, or undefined. */
export function fileNameProblem(fileName: string, separator: ServerPathSeparator): string | undefined {
  if (fileName === '') return 'Enter a file name.'
  if (fileName.length > actionLimits.serverPath) return `A file name is at most ${actionLimits.serverPath} characters.`
  if (fileName === '.' || fileName === '..') return 'A file name cannot be . or ..'
  if (new RegExp((separator === '\\' ? windowsForbidden : linuxForbidden).source).test(fileName)) {
    return separator === '\\' ? 'A file name cannot contain control characters or \\ / : * ? " < > |.' : 'A file name cannot contain control characters or / * ? " < > |.'
  }
  if (new RegExp(brokenPairs.source).test(fileName)) return 'The file name holds a broken character (half of a surrogate pair).'
  if (separator === '\\' && /[. ]$/.test(fileName)) return 'On Windows a file name cannot end with a dot or a space.'
  if (separator === '\\' && windowsReserved.test(fileName)) return 'On Windows a file name cannot be a device name such as CON or NUL.'
  return undefined
}
/** The file's full path on the server: its folder, the separator and its file name. */
export const filePath = (file: Pick<NewDatabaseFile, 'path' | 'fileName'>, separator: ServerPathSeparator = separatorOf(file.path)): string => folderPath(file.path, separator) + file.fileName
/** The folder of a file the picker chose, as the design keeps it: without a trailing separator, but a root keeps its own. */
export const folderOf = (path: string, separator: ServerPathSeparator): string =>
  path.endsWith(separator) && path !== '/' && !/^[A-Za-z]:\\$/.test(path) ? path.slice(0, -1) : path

// --- Statements after CREATE DATABASE ----------------------------------------------------------------------------------------

/** One filegroup change after CREATE: Autogrow All Files, then the default rows filegroup, then Read-Only (a read-only
 *  filegroup takes no other change). */
export interface FilegroupChange { readonly kind: 'autogrowAll' | 'default' | 'readOnly'; readonly filegroup: string }
export function filegroupChanges(design: Pick<NewDatabaseDesign, 'filegroups'>): FilegroupChange[] {
  const rows = design.filegroups.filter(group => group.type === 'rows')
  return [
    ...rows.filter(group => group.autogrowAllFiles).map(group => ({ kind: 'autogrowAll' as const, filegroup: group.name })),
    ...rows.filter(group => group.isDefault && group.name !== primaryFilegroup).map(group => ({ kind: 'default' as const, filegroup: group.name })),
    ...rows.filter(group => group.readOnly).map(group => ({ kind: 'readOnly' as const, filegroup: group.name }))
  ]
}
/** How many statements OK runs: CREATE, an ALTER per option and scoped configuration (incremental statistics shares Auto
 *  Create Statistics' when both change), the filegroup changes and the owner. */
export function newDatabaseStatements(design: NewDatabaseDesign): number {
  const options = Object.keys(design.options)
  const shared = options.includes('autoCreateStatistics') && options.includes('autoCreateIncrementalStatistics') ? 1 : 0
  return 1 + options.length - shared + Object.keys(design.scoped).length + filegroupChanges(design).length + (design.owner === undefined ? 0 : 1)
}

// --- Rules ---------------------------------------------------------------------------------------------------------------------

/** What the server is, for the rules only it decides: the version band, its path separator, Linux, FILESTREAM's level and
 *  contained database authentication. Without facts (main's zod check) those rules wait for the backend's preflight. */
export interface NewDatabaseFacts {
  readonly level: number
  readonly separator: ServerPathSeparator
  readonly linux: boolean
  readonly filestreamLevel: number
  readonly containedAuthentication: boolean
}
/** A problem and the field it is about: a file or filegroup by index, an option by key. */
export interface NewDatabaseProblem {
  readonly field: 'name' | 'owner' | 'files' | 'filegroups' | 'collation' | 'containment' | 'ledger' | 'options'
  readonly file?: number
  readonly filegroup?: number
  readonly key?: string
  readonly column?: 'name' | 'filegroup' | 'size' | 'growth' | 'path' | 'fileName'
  readonly message: string
}
const sysname = (value: string) => value.length >= 1 && value.length <= 128 && !value.includes('\u0000')
const fold = (value: string) => value.toLowerCase()
const label = (file: NewDatabaseFile, index: number) => file.name === '' ? `File ${index + 1}` : `The file ${file.name}`

/** Why a growth cannot be a file's: a growth of 1 MB to 2 TB or 1 to 100 percent, and a maximum no smaller than the size. */
function growthProblem(file: NewDatabaseFile): string | undefined {
  const growth = file.growth
  if (file.type === 'filestream') return growth.enabled ? 'A FILESTREAM or memory-optimized container has no autogrowth; it grows as it needs.' : undefined
  if (!growth.enabled) return undefined
  const whole = (value: number) => Number.isInteger(value)
  if (growth.unit === 'mb' && !(whole(growth.by) && growth.by >= 1 && growth.by <= actionLimits.growthMb)) return `File growth is a whole number of MB from 1 to ${actionLimits.growthMb.toLocaleString('en-US')}.`
  if (growth.unit === 'percent' && !(whole(growth.by) && growth.by >= 1 && growth.by <= actionLimits.growthPercent)) return 'File growth in percent is a whole number from 1 to 100.'
  const ceiling = file.type === 'log' ? actionLimits.logFileMb : actionLimits.dataFileMb
  if (growth.maxMb !== undefined && !(whole(growth.maxMb) && growth.maxMb >= (file.sizeMb ?? 1) && growth.maxMb <= ceiling)) {
    return `The maximum file size is a whole number of MB from the initial size to ${ceiling.toLocaleString('en-US')}.`
  }
  return undefined
}

/**
 * Every problem with a design, in the order the document shows them. `facts` adds the server's rules: Linux has no FILESTREAM,
 * FILESTREAM must be enabled, ledger needs SQL Server 2022, Partial containment needs contained database authentication, an
 * option's version band, and the file names the server's platform refuses.
 */
export function newDatabaseProblems(name: string, design: NewDatabaseDesign, facts?: NewDatabaseFacts): NewDatabaseProblem[] {
  const problems: NewDatabaseProblem[] = []
  const add = (problem: NewDatabaseProblem) => { problems.push(problem) }
  if (name.trim() === '') add({ field: 'name', message: 'Enter a database name.' })
  else if (!sysname(name)) add({ field: 'name', message: 'A database name is at most 128 characters, without U+0000.' })
  else if (systemDatabaseNames.includes(fold(name))) add({ field: 'name', message: `${name} is a system database's name.` })
  if (design.owner !== undefined && !sysname(design.owner)) add({ field: 'owner', message: 'Owner must be a login name of 1 to 128 characters.' })
  if (design.collation !== undefined && !collationPattern.test(design.collation)) add({ field: 'collation', message: 'Not a collation name.' })
  // Filegroups.
  const groups = design.filegroups
  if (groups.length === 0 || groups[0].name !== primaryFilegroup || groups[0].type !== 'rows') add({ field: 'filegroups', message: 'PRIMARY must be the first filegroup.' })
  if (groups.length > actionLimits.newDatabaseFilegroups) add({ field: 'filegroups', message: `A database has at most ${actionLimits.newDatabaseFilegroups} filegroups here.` })
  const groupNames = new Map<string, number>()
  groups.forEach((group, index) => {
    if (!sysname(group.name)) add({ field: 'filegroups', filegroup: index, message: 'A filegroup name is 1 to 128 characters, without U+0000.' })
    else if (groupNames.has(fold(group.name))) add({ field: 'filegroups', filegroup: index, message: `Two filegroups are named ${group.name}.` })
    else groupNames.set(fold(group.name), index)
    if (group.type !== 'rows' && (group.readOnly || group.autogrowAllFiles)) add({ field: 'filegroups', filegroup: index, message: `Read-Only and Autogrow All Files apply to rows filegroups only (${group.name}).` })
    if (group.type === 'memoryOptimized' && group.isDefault) add({ field: 'filegroups', filegroup: index, message: 'A memory-optimized filegroup is never the default.' })
    if (group.readOnly && (index === 0 || group.isDefault)) add({ field: 'filegroups', filegroup: index, message: `${group.name} cannot be read-only: PRIMARY and the default filegroup stay read-write.` })
    if (group.autogrowAllFiles && facts && facts.level < 13) add({ field: 'filegroups', filegroup: index, message: 'Autogrow All Files needs SQL Server 2016 or later.' })
  })
  for (const type of ['rows', 'filestream'] as const) {
    if (groups.filter(group => group.type === type && group.isDefault).length > 1) add({ field: 'filegroups', message: `Only one ${type === 'rows' ? 'rows' : 'FILESTREAM'} filegroup can be the default.` })
  }
  if (groups.filter(group => group.type === 'memoryOptimized').length > 1) add({ field: 'filegroups', message: 'A database has at most one memory-optimized filegroup.' })
  // Files.
  const files = design.files
  if (files.length > actionLimits.newDatabaseFiles) add({ field: 'files', message: `A database has at most ${actionLimits.newDatabaseFiles} files here.` })
  if (!files.some(file => file.type === 'rows' && file.filegroup === primaryFilegroup) || files[0]?.type !== 'rows' || files[0]?.filegroup !== primaryFilegroup) {
    add({ field: 'files', message: 'The first file must be a ROWS data file in PRIMARY: it is the primary data file.' })
  }
  if (!files.some(file => file.type === 'log')) add({ field: 'files', message: 'A database needs a log file.' })
  const fileNames = new Set<string>(), paths = new Set<string>()
  files.forEach((file, index) => {
    const at = { field: 'files' as const, file: index }
    if (!sysname(file.name)) add({ ...at, column: 'name', message: `${label(file, index)}: a logical name is 1 to 128 characters, without U+0000.` })
    else if (fileNames.has(fold(file.name))) add({ ...at, column: 'name', message: `Two files are named ${file.name}.` })
    else fileNames.add(fold(file.name))
    const group = file.filegroup === undefined ? undefined : groups[groupNames.get(fold(file.filegroup)) ?? -1]
    if (file.type === 'log' && file.filegroup !== undefined) add({ ...at, column: 'filegroup', message: `${label(file, index)}: a log file has no filegroup.` })
    if (file.type !== 'log' && (!group || group.name !== file.filegroup)) add({ ...at, column: 'filegroup', message: `${label(file, index)}: choose one of the database's filegroups.` })
    else if (file.type === 'rows' && group && group.type !== 'rows') add({ ...at, column: 'filegroup', message: `${label(file, index)}: a ROWS data file goes in a rows filegroup.` })
    else if (file.type === 'filestream' && group && group.type === 'rows') add({ ...at, column: 'filegroup', message: `${label(file, index)}: FILESTREAM data goes in a FILESTREAM or memory-optimized filegroup.` })
    const ceiling = file.type === 'log' ? actionLimits.logFileMb : actionLimits.dataFileMb
    if (file.type === 'filestream' ? file.sizeMb !== undefined : !(file.sizeMb !== undefined && Number.isInteger(file.sizeMb) && file.sizeMb >= 1 && file.sizeMb <= ceiling)) {
      add({ ...at, column: 'size', message: file.type === 'filestream' ? `${label(file, index)}: a container has no initial size.` : `${label(file, index)}: the initial size is a whole number of MB from 1 to ${ceiling.toLocaleString('en-US')}.` })
    }
    const growth = growthProblem(file)
    if (growth) add({ ...at, column: 'growth', message: `${label(file, index)}: ${growth}` })
    const separator = facts?.separator ?? separatorOf(file.path)
    const pathProblem = serverPathProblem(file.path)
    if (pathProblem) { add({ ...at, column: 'path', message: `${label(file, index)}: ${pathProblem}` }); return }
    const nameProblem = fileNameProblem(file.fileName, separator)
    if (nameProblem) { add({ ...at, column: 'fileName', message: `${label(file, index)}: ${nameProblem}` }); return }
    const full = filePath(file, separator), fullProblem = serverPathProblem(full)
    if (fullProblem) add({ ...at, column: 'fileName', message: `${label(file, index)}: ${fullProblem}` })
    else if (paths.has(separator === '\\' ? fold(full) : full)) add({ ...at, column: 'fileName', message: `Two files have the path ${full}.` })
    else paths.add(separator === '\\' ? fold(full) : full)
  })
  groups.forEach((group, index) => {
    if (sysname(group.name) && !files.some(file => file.type !== 'log' && file.filegroup !== undefined && fold(file.filegroup) === fold(group.name))) {
      add({ field: 'filegroups', filegroup: index, message: `The filegroup ${group.name} has no files. Add a file to it, or remove it.` })
    }
  })
  // Options.
  for (const [key, token] of Object.entries(design.options)) {
    const def = newDatabaseOptionKeys.includes(key) ? optionDef(key) : undefined
    if (!def) { add({ field: 'options', key, message: 'Unknown option.' }); continue }
    const problem = tokenProblem(def, token)
    if (problem) add({ field: 'options', key, message: problem })
    else if (facts && def.since !== undefined && facts.level < def.since) add({ field: 'options', key, message: `${def.label} needs a newer version of SQL Server.` })
  }
  for (const [key, token] of Object.entries(design.scoped)) {
    const def = newDatabaseScopedKeys.includes(key) ? optionDef(key) : undefined
    const problem = def ? tokenProblem(def, token) : 'Unknown option.'
    if (problem) add({ field: 'options', key, message: problem })
  }
  if (design.options.autoCreateIncrementalStatistics !== undefined && design.options.autoCreateStatistics === 'false') {
    add({ field: 'options', key: 'autoCreateIncrementalStatistics', message: 'Auto Create Statistics must be True for incremental statistics.' })
  }
  // Turning Database Read-Only on refuses what SQL Server would refuse after it (DatabaseAlter.Plan's rule).
  if (design.options.readOnly === 'true') {
    const after = optionDef('readOnly')!.smoOrder
    for (const key of [...Object.keys(design.options), ...Object.keys(design.scoped)]) {
      const def = optionDef(key)
      if (def?.refusedReadOnly && def.smoOrder > after) add({ field: 'options', key, message: afterReadOnlyProblem(def.label) })
    }
    if (filegroupChanges(design).length) add({ field: 'filegroups', message: afterReadOnlyProblem('A filegroup change') })
    if (design.owner !== undefined) add({ field: 'owner', message: afterReadOnlyProblem('Owner') })
  }
  if (newDatabaseStatements(design) > actionLimits.statements) add({ field: 'options', message: 'The database has too many changes to make at once.' })
  // The server's rules.
  if (facts) {
    if (design.ledger && facts.level < 16) add({ field: 'ledger', message: 'A ledger database needs SQL Server 2022 or later.' })
    if (design.containment === 'PARTIAL' && !facts.containedAuthentication) add({ field: 'containment', message: 'Partial containment needs the server option contained database authentication.' })
    if (groups.some(group => group.type === 'filestream')) {
      if (facts.linux) add({ field: 'filegroups', message: 'SQL Server on Linux has no FILESTREAM.' })
      else if (facts.filestreamLevel === 0) add({ field: 'filegroups', message: 'FILESTREAM is not enabled on this server.' })
    }
  }
  return problems
}

// --- The baseline -------------------------------------------------------------------------------------------------------------

/**
 * Where a new database does not take model's value: CREATE DATABASE sets these itself, whatever model says (measured on SQL
 * Server 2016 to 2025 by the live check that creates a database and compares it with model). The document starts from model's
 * values with these over them, and sends only what differs from that. CREATE DATABASE gives every new database a new Service
 * Broker identifier with the broker enabled, though model's is disabled.
 */
export const newDatabaseOverrides: Readonly<Record<string, string>> = { brokerEnabled: 'true' }
/** The options and scoped configurations a new database gets when OK sends none: model's, with `newDatabaseOverrides`. */
export function newDatabaseBaseline(model: Pick<DatabasePropertiesModel, 'options' | 'scoped'>): { readonly options: Readonly<Record<string, string>>; readonly scoped: Readonly<Record<string, string>> } {
  const pick = (values: Readonly<Record<string, string>>, keys: readonly string[]) =>
    Object.fromEntries(keys.flatMap(key => newDatabaseOverrides[key] !== undefined ? [[key, newDatabaseOverrides[key]]] : values[key] === undefined ? [] : [[key, values[key]]]))
  return { options: pick(model.options, newDatabaseOptionKeys), scoped: pick(model.scoped, newDatabaseScopedKeys) }
}
/** What differs from the baseline: what OK and Script send. */
export function changedFrom(baseline: Readonly<Record<string, string>>, values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => baseline[key] !== value))
}
