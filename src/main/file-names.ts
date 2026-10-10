import { scriptLimits } from '../shared/scripting/catalog.ts'

// C0 and C1 controls, line and paragraph separators, bidi embeddings, overrides and isolates, the BOM, and the
// characters Windows forbids in file names (which also covers path separators).
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\\/:*?"<>|]/g
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const fallback = 'Script.sql'
const trailing = /[. ]+$/

/**
 * A file name the Save dialog can suggest on every platform, whatever an object name holds: unsafe characters become
 * `_`, trailing dots and spaces go (Windows drops them), a reserved Windows stem gets a `_` prefix, and the name keeps at
 * most 200 UTF-16 units, its extension included, without splitting a surrogate pair. Nothing left gives `Script.sql`.
 */
export function sanitizeFileName(name: string): string {
  let safe = name.replace(unsafe, '_').replace(trailing, '')
  if (reserved.test(safe)) safe = '_' + safe
  if (safe.length > scriptLimits.fileNameChars) {
    const extension = /\.[A-Za-z0-9]{1,8}$/.exec(safe)?.[0] ?? ''
    let end = scriptLimits.fileNameChars - extension.length
    if (/[\ud800-\udbff]/.test(safe[end - 1])) end--
    safe = safe.slice(0, end).replace(trailing, '') + extension
  }
  return safe.replace(/^\.+$/, '') || fallback
}
