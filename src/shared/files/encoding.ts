import type { FileEncoding, LineEnding, SqlFile } from '../contracts'

/** The status bar's name for an encoding, as Visual Studio's: 'UTF-8 with BOM', or the code page a legacy file was read in. */
export function encodingLabel(encoding: FileEncoding, codePage?: string): string {
  return { utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', utf16leNoBom: 'UTF-16 LE without BOM', utf16beNoBom: 'UTF-16 BE without BOM', legacy: codePage ?? 'ANSI' }[encoding]
}
/**
 * The status bar's encoding for a document: a file's own until a save converts it, and for a query never saved what its
 * first save writes, Save files with a specific encoding's choice (`specific`, while it is on) or UTF-8.
 */
export function documentEncodingLabel(file: Pick<SqlFile, 'encoding' | 'codePage'> | undefined, specific?: Exclude<FileEncoding, 'legacy'>): string {
  return file ? encodingLabel(file.encoding, file.codePage) : encodingLabel(specific ?? 'utf8')
}
export const lineEndingLabel = (eol: LineEnding): string => eol === 'crlf' ? 'CRLF' : 'LF'
/** A new query's line ending: the platform's, as SSMS writes CRLF on Windows. */
export const platformLineEnding = (platform: string): LineEnding => platform === 'win32' ? 'crlf' : 'lf'
