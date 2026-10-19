import type { FileEncoding, LineEnding } from '../contracts'

/** The status bar's name for an encoding, as Visual Studio's: 'UTF-8 with BOM', or the code page a legacy file was read in. */
export function encodingLabel(encoding: FileEncoding, codePage?: string): string {
  return { utf8: 'UTF-8', utf8bom: 'UTF-8 with BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', legacy: codePage ?? 'ANSI' }[encoding]
}
export const lineEndingLabel = (eol: LineEnding): string => eol === 'crlf' ? 'CRLF' : 'LF'
/** A new query's line ending: the platform's, as SSMS writes CRLF on Windows. */
export const platformLineEnding = (platform: string): LineEnding => platform === 'win32' ? 'crlf' : 'lf'
