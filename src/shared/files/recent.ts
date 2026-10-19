import { z } from 'zod'
import { sanitizeLabel } from '../theme/format'

/** File › Recent Files. Main owns the list (`<userData>/recent-files.json`); the renderer sees ids, names and paths. */
export const recentFilesLimits = {
  /** Entries kept on disk; Options' count (1–24) chooses how many show. */
  entries: 50,
  fileBytes: 256 * 1024,
  pathChars: 4096,
  nameChars: 260,
  /** A menu item's path, shortened in the middle. */
  labelChars: 60,
  openedAtChars: 40
} as const

/** recent-files.json, strict: anything else is quarantined, as settings are. */
export const recentFilesFileSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string().min(1).max(recentFilesLimits.pathChars), openedAt: z.iso.datetime().max(recentFilesLimits.openedAtChars) }).strict()).max(recentFilesLimits.entries)
}).strict()
export type RecentFilesFile = z.infer<typeof recentFilesFileSchema>

/** One entry as the renderer sees it: `id` is an opaque uuid main maps to the path, never persisted. */
export interface RecentFile { readonly id: string; readonly name: string; readonly path: string }

/**
 * A path cut in the middle to at most `max` characters, as Visual Studio's File › Recent Files shows it: the root, an
 * ellipsis, and as many trailing folders as fit before the file name ("C:\…\Queries\orders.sql"). A name too long by
 * itself keeps its start and its extension.
 */
export function shortenPath(path: string, max: number = recentFilesLimits.labelChars): string {
  if (path.length <= max) return path
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/)
  const name = parts.pop() ?? ''
  const root = parts.length ? parts.shift()! + separator : ''
  let tail = name
  for (let index = parts.length - 1; index >= 0; index--) {
    const candidate = parts[index] + separator + tail
    if ((root + '…' + separator + candidate).length > max) break
    tail = candidate
  }
  const shortened = root + '…' + separator + tail
  if (shortened.length <= max) return shortened
  // Only the name is left, and it is too long: its start, an ellipsis, and its last eight characters (the extension).
  const end = name.slice(-8), start = Math.max(1, max - end.length - 1)
  return name.slice(0, start) + '…' + end
}

export type RecentMenuItem =
  | { readonly kind: 'file'; readonly id: string; readonly label: string; readonly mnemonic?: string }
  | { readonly kind: 'empty'; readonly label: string }
  | { readonly kind: 'clear'; readonly label: string }
  | { readonly kind: 'separator' }

/**
 * File › Recent Files' items, for main's native menu and the renderer's: "1 C:\…\orders.sql" with the digits 1–9 and 0
 * as access keys (macOS shows the path alone, without access keys), then Clear Recent Files; an empty list shows one
 * disabled No Recent Files. Paths are shortened and stripped of control and bidi characters.
 */
export function recentFilesMenuModel(list: readonly RecentFile[], platform: string): RecentMenuItem[] {
  if (!list.length) return [{ kind: 'empty', label: 'No Recent Files' }]
  const mac = platform === 'darwin'
  const files = list.map((file, index): RecentMenuItem => {
    const path = sanitizeLabel(shortenPath(file.path), recentFilesLimits.labelChars + 1)
    const digit = index < 9 ? String(index + 1) : index === 9 ? '0' : undefined
    return { kind: 'file', id: file.id, label: mac ? path : `${index + 1} ${path}`, ...!mac && digit ? { mnemonic: digit } : {} }
  })
  return [...files, { kind: 'separator' }, { kind: 'clear', label: 'Clear Recent Files' }]
}
