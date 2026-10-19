import { scriptLimits } from '../shared/scripting/catalog.ts'

// C0 and C1 controls, line and paragraph separators, bidi marks, embeddings, overrides and isolates, the BOM, and the
// characters Windows forbids in file names (which also covers path separators).
const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\\/:*?"<>|]/g
// Windows' device names, which it ignores trailing spaces after; COM and LPT take a digit 0-9 or a superscript ¹²³.
const reserved = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i
const fallback = 'Script.sql'
const trailing = /[. ]+$/
/** ext4 and APFS allow 255 bytes per name; this leaves room for a suffix the Save dialog or the user adds. */
const maxBytes = 240

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
