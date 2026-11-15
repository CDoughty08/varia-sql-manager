import { fileNameBytes, unsafeFileNameChars } from '../../../shared/file-names'
import { limits as wire } from '../../../shared/ipc/wire/protocol'

/**
 * What Save Results As names a file after: a group's Table or its Pivot, by the result's number and the name its query gave
 * it (`#Name`), with `collides` when another result of the run has a name that makes the same file name; or a comparison,
 * by its place among the run's comparisons in the order they were made.
 */
export type SaveSubject =
  | { readonly view: 'table' | 'pivot'; readonly number: number; readonly name?: string; readonly collides?: boolean; readonly transposed?: boolean }
  | { readonly view: 'comparison'; readonly number: number }
/** A suggested file name without its extension, and its tail that tells results apart (`-Result2-Pivot`), which main
 *  never cuts when it shortens a name: the tab's name, then the result's, give way first. */
export interface SaveName { readonly name: string; readonly suffix: string }

export const saveNameLimits = {
  /** A result's name keeps at most this many UTF-16 units in a file name; a longer one is cut and numbered. */
  nameChars: 64,
  /** UTF-8 bytes for the name without its extension: main's limit less the longest extension it adds ('.json'). */
  bytes: fileNameBytes - 5,
  /** UTF-16 units, as main accepts them. */
  chars: wire.jobs.suggestedName
} as const

const encoder = new TextEncoder()
const bytes = (text: string): number => encoder.encode(text).length
const fits = (text: string): boolean => text.length <= saveNameLimits.chars && bytes(text) <= saveNameLimits.bytes
/** The longest start of `text`, cut between code points, that `fits` with `rest` after it; trailing spaces and dots go,
 *  since Windows drops them. */
function longest(text: string, fit: (kept: string) => boolean): string {
  let kept = ''
  for (const character of text) {
    if (!fit(kept + character)) break
    kept += character
  }
  return kept.replace(/[. ]+$/, '')
}

/**
 * A result's name as a file name holds it: each character no file name may hold becomes `_` (as main's sanitizeFileName
 * does), spaces are kept. Undefined when nothing of the name would be left to read: all of it refused characters, dots or
 * spaces, so the file is named by the result's number instead.
 */
export function fileNamePart(name: string | undefined): string | undefined {
  const cleaned = name?.replace(unsafeFileNameChars, '_').trim()
  return cleaned && /[^_.\s]/u.test(cleaned) ? cleaned : undefined
}
/** Whether two results' names make the same file name: case aside, since Windows and macOS file names ignore it. */
export const sameFileName = (a: string | undefined, b: string | undefined): boolean => {
  const x = fileNamePart(a), y = fileNamePart(b)
  return x !== undefined && y !== undefined && x.toLowerCase() === y.toLowerCase()
}

/**
 * Save Results As's suggested name (grouped results plan, Concurrency and limits; named result sets scope, Save names):
 * `{tab}-Result2`, `{tab}-Result2-Pivot`, `{tab}-Differences1`, with `-Transposed` when the grid is drawn so; a named
 * result's name stands where its number would, `{tab}-Open orders`, `{tab}-Open orders-Pivot`. The number stays beside a
 * name when the name alone could not tell the file apart: another result of the run makes the same file name, or the name
 * was cut. A name of nothing but refused characters is named by its number.
 *
 * The whole fits what main accepts (128 UTF-16 units) and what a file system holds once main adds the extension, so main
 * never has to cut it; the tab's name gives way first, then the result's, never the suffix.
 */
export function saveName(tab: string, subject: SaveSubject): SaveName {
  const extra = subject.view === 'pivot' ? '-Pivot' : ''
  const turned = subject.view !== 'comparison' && subject.transposed ? '-Transposed' : ''
  const numbered = subject.view === 'comparison' ? `-Differences${subject.number}` : `-Result${subject.number}${extra}${turned}`
  const name = subject.view === 'comparison' ? undefined : fileNamePart(subject.name)
  if (name !== undefined) {
    const cut = name.length > saveNameLimits.nameChars
    let part = cut ? longest(name, kept => kept.length <= saveNameLimits.nameChars) : name
    let suffix = cut || (subject.view !== 'comparison' && subject.collides) ? numbered : extra + turned
    // The tab gives way first; a tab cut to nothing leaves the name alone, without the dash.
    const stem = longest(tab, kept => fits(`${kept}-${part}${suffix}`))
    if (fits(`${stem}-${part}${suffix}`)) return { name: stem ? `${stem}-${part}${suffix}` : `${part}${suffix}`, suffix }
    // A name too long even alone (characters of three or four bytes): it is cut, and so takes its number.
    suffix = numbered
    part = longest(part, kept => fits(kept + suffix))
    if (part && fileNamePart(part) !== undefined) return { name: part + suffix, suffix }
  }
  const stem = longest(tab, kept => fits(kept + numbered))
  return { name: stem + numbered, suffix: numbered }
}
