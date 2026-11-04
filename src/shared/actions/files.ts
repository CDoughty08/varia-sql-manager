// The server file picker's request and listing, and the rules for a path on the server: main's zod schema, the renderer's
// File name box and the later dialogs that take a server path (New Database, Attach, Restore) share them, and
// ServerPath.cs mirrors the character rules. Paths are the server's: their separator comes from the server, never from
// the client's platform. Erasable TypeScript, so Node's type stripping can load it too.
import { actionLimits, type ServerFilePurpose } from './catalog.ts'

export type ServerPathSeparator = '\\' | '/'
/** What the picker asks: one folder's entries, or with no path the server's drives and default folders. */
export interface ServerFilesRequest {
  readonly purpose: ServerFilePurpose
  readonly path?: string
  /** Files of type: All Files(*.*) instead of the purpose's extensions; a folder picker lists folders only. */
  readonly allFiles?: boolean
  /** Whether `path` itself exists, rather than its entries: for a typed name the listing does not show (past its limit, or
   *  outside the type filter). The answer's entries hold the path's own entry, or none. */
  readonly exists?: boolean
}
/** A drive, or one of the instance's default data, log and backup folders (one row when they are the same folder). */
export interface ServerRoot {
  readonly path: string
  readonly kind: 'drive' | 'folder'
  readonly defaults?: readonly ('data' | 'log' | 'backup')[]
  readonly freeMb?: number
}
/** One entry of a folder; size and time (the server's local time, yyyy-MM-ddTHH:mm:ss) only where the server reports them. */
export interface ServerFileEntry { readonly name: string; readonly directory: boolean; readonly sizeBytes?: number; readonly modified?: string }
export interface ServerFilesListing {
  readonly separator: ServerPathSeparator
  /** The folder listed, ending with the separator (for `exists`, the path checked, without one); absent when the roots were asked for. */
  readonly path?: string
  /** Only when no path was asked. */
  readonly roots: readonly ServerRoot[]
  /** Folders first, then files, by name; at most `actionLimits.browseEntries`. */
  readonly entries: readonly ServerFileEntry[]
  readonly truncated: boolean
  /** SQL Server 2016 lists folders only to members of sysadmin, and to others answers with nothing rather than an error; a
   *  check carries it when the server would not say whether the path exists. */
  readonly notice?: 'legacyEmpty'
}

/** Characters Windows refuses in a path, and control characters, which no SQL Server path holds; Linux allows `*?"<>|`, but
 *  Varia cannot pick such a file (README). */
const forbidden = /[\u0000-\u001f*?"<>|]/
const brokenPair = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
/** A drive (C:\), a UNC share (\\server\share), or an absolute Linux path. */
const absolute = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+|\/)/

/** Why a path cannot be a server path, or undefined: 1–260 UTF-16 units, well formed, no control or wildcard characters, absolute. */
export function serverPathProblem(path: string): string | undefined {
  if (path.length === 0) return 'Enter a path.'
  if (path.length > actionLimits.serverPath) return `A path is at most ${actionLimits.serverPath} characters.`
  if (brokenPair.test(path)) return 'The path holds a broken character (half of a surrogate pair).'
  if (forbidden.test(path)) return 'A path cannot contain control characters or * ? " < > |.'
  if (!absolute.test(path)) return 'Enter a full path: a drive (C:\\…), a share (\\\\server\\share\\…) or, on Linux, /….'
  return undefined
}

/** Whether a typed name is a path on its own (absolute) rather than a name in the selected folder. */
export const isAbsoluteServerPath = (text: string): boolean => absolute.test(text)

/** The path as the server writes it: on Windows, forward slashes become backslashes. */
export const serverPathText = (path: string, separator: ServerPathSeparator): string => separator === '\\' ? path.replaceAll('/', '\\') : path

/** A folder path ending with the separator. */
export const folderPath = (path: string, separator: ServerPathSeparator): string => {
  const text = serverPathText(path, separator)
  return text.endsWith(separator) ? text : text + separator
}

/** The folder and the name of a file path (the name is '' for a folder path). */
export function splitServerPath(path: string, separator: ServerPathSeparator): { readonly folder: string; readonly name: string } {
  const text = serverPathText(path, separator)
  const at = text.lastIndexOf(separator)
  return at < 0 ? { folder: '', name: text } : { folder: text.slice(0, at + 1), name: text.slice(at + 1) }
}

/** The first folder of a path: C:\, \\server\share\ or /. */
export function serverPathRoot(path: string, separator: ServerPathSeparator): string | undefined {
  const text = serverPathText(path, separator)
  if (separator === '/') return text.startsWith('/') ? '/' : undefined
  if (/^[A-Za-z]:\\/.test(text)) return text.slice(0, 3)
  const share = /^\\\\[^\\]+\\[^\\]+/.exec(text)
  return share ? share[0] + '\\' : undefined
}

/**
 * The folders from a path's root down to the folder itself: C:\a\b\ gives C:\, C:\a\ and C:\a\b\. Empty segments (a doubled
 * separator) are skipped, so each step is a folder the server can list.
 */
export function serverPathChain(folder: string, separator: ServerPathSeparator): string[] {
  const root = serverPathRoot(folder, separator)
  if (!root) return []
  const chain = [root]
  let current = root
  for (const segment of serverPathText(folder, separator).slice(root.length).split(separator)) {
    if (!segment) continue
    current += segment + separator
    chain.push(current)
  }
  return chain
}

/** Whether two server paths name the same file or folder: Windows compares without case, Linux exactly. */
export const sameServerPath = (a: string, b: string, separator: ServerPathSeparator): boolean =>
  separator === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b

/**
 * A full path as the file it names, for telling whether two spellings are one file (ServerPath.Key in C#, the same
 * tests/fixtures/server-paths.json): empty and '.' segments dropped and '..' resolved; on Windows also forward slashes as
 * backslashes, each segment's trailing dots and spaces dropped (as Win32 drops them), and upper case. Undefined when it is not
 * a full path there, or on Windows names a stream (a colon past the drive).
 */
export function serverPathKey(path: string, separator: ServerPathSeparator): string | undefined {
  const segments = (parts: readonly string[], linux: boolean) => {
    const kept: string[] = []
    for (const part of parts) {
      if (part === '..') { kept.pop(); continue }
      const segment = linux ? part : part.replace(/[. ]+$/, '')
      if (segment && segment !== '.') kept.push(segment)
    }
    return kept
  }
  if (separator === '/') return path.startsWith('/') ? '/' + segments(path.split('/'), true).join('/') : undefined
  const text = serverPathText(path, '\\')
  let root: string, rest: string[]
  if (/^[A-Za-z]:\\/.test(text)) [root, rest] = [text.slice(0, 3), text.slice(3).split('\\')]
  else {
    const share = text.startsWith('\\\\') ? text.slice(2).split('\\') : []
    if (share.length < 2 || !share[0] || !share[1]) return undefined
    ;[root, rest] = [`\\\\${share[0]}\\${share[1]}\\`, share.slice(2)]
  }
  const kept = segments(rest, false)
  if (root.indexOf(':', 2) >= 0 || kept.some(segment => segment.includes(':'))) return undefined
  return (root + kept.join('\\')).toUpperCase()
}

/** The folder a path lists on a server with this separator (ServerPath.Folder in C#, the same tests/fixtures/server-paths.json):
 *  ending with the separator, or undefined when it is not a full path there (a drive or share on Linux, / on Windows). */
export function serverFolder(path: string, separator: ServerPathSeparator): string | undefined {
  if (separator === '/') return path.startsWith('/') ? folderPath(path, '/') : undefined
  const text = serverPathText(path, '\\')
  return /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(text) ? folderPath(text, '\\') : undefined
}
