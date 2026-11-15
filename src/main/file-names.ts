import { basename, dirname, join } from 'node:path'
import { scriptLimits } from '../shared/scripting/catalog.ts'
import { fileNameBytes, unsafeFileNameChars as unsafe } from '../shared/file-names.ts'

// Windows' device names, which it ignores trailing spaces after; COM and LPT take a digit 0-9 or a superscript ¹²³.
const reserved = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i
const fallback = 'Script.sql'
const trailing = /[. ]+$/
const maxBytes = fileNameBytes

/** `text` cut to whole code points so that it and `extension` fit `units` UTF-16 units and `bytes` UTF-8 bytes. */
function fit(text: string, extension: string, units: number, bytes: number): string {
  if (text.length + extension.length <= units && Buffer.byteLength(text + extension) <= bytes) return text + extension
  let kept = '', size = Buffer.byteLength(extension)
  for (const character of text) {
    size += Buffer.byteLength(character)
    if (kept.length + character.length + extension.length > units || size > bytes) break
    kept += character
  }
  return kept.replace(trailing, '') + extension
}

/**
 * A file name the Save dialog can suggest on every platform, whatever an object name holds: unsafe characters become
 * `_`, trailing dots and spaces go (Windows drops them), the name keeps at most 200 UTF-16 units and 240 UTF-8 bytes,
 * its extension included, cut between code points, and a reserved Windows stem, checked after the cut, gets a `_`
 * prefix. Nothing left gives `Script.sql`. A short `suffix` (Save Results As's `-Result2`) goes between the stem and
 * the extension and is never cut: the stem gives way, so names that differ only in it stay distinct.
 */
export function sanitizeFileName(name: string, suffix = ''): string {
  const cleaned = name.replace(unsafe, '_').replace(trailing, '')
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(cleaned)?.[0] ?? ''
  const stem = cleaned.slice(0, cleaned.length - extension.length), tail = suffix.replace(unsafe, '_') + extension
  let safe = fit(stem, tail, scriptLimits.fileNameChars, maxBytes)
  if (reserved.test(safe)) safe = '_' + fit(stem, tail, scriptLimits.fileNameChars - 1, maxBytes - 1)
  return safe.replace(/^\.+$/, '') || fallback
}

/**
 * Where the Save dialog starts. A document never saved suggests its tab's name in Documents; a saved one its file, unless
 * the user renamed its tab (the name differs from the file's), when Save As suggests that name beside the file. A name
 * without an extension gets the kind's (`extension`, without the dot).
 */
export function saveDefaultPath(registeredPath: string | undefined, name: string, documents: string, extension: string): string {
  const withExtension = /\.[A-Za-z0-9]{1,8}$/.test(name.trim()) ? name : `${name}.${extension}`
  if (!registeredPath) return join(documents, sanitizeFileName(withExtension))
  if (name === basename(registeredPath)) return registeredPath
  return join(dirname(registeredPath), sanitizeFileName(withExtension))
}
