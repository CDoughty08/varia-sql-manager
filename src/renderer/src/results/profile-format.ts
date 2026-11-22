// The column profile panel's text: what each card says about a column (results.profile's figures), in one place so the
// panel and its checks agree.
import type { ColumnProfile, ProfileBasis, ProfileLengths } from '../../../shared/contracts'
import { formatCount } from './status'

/** A size in bytes as the panel shows it: whole bytes under 1 KB, then KB, MB and GB with one decimal. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${units[unit]}`
}

const average = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1 })

/** "1 – 30 · avg 12.5", "(estimated)" when an estimate took part; `size` formats bytes. */
export function lengthText(lengths: ProfileLengths, size = false): string {
  const show = size ? formatSize : formatCount
  const range = lengths.min === lengths.max ? show(lengths.min) : `${show(lengths.min)} – ${show(lengths.max)}`
  return `${range} · avg ${size ? formatSize(Math.round(lengths.average)) : average(lengths.average)}${lengths.exact ? '' : ' (estimated)'}`
}

/** What a column's card lists, in order: NULLs, distinct values, lowest and highest, lengths and bytes. */
export function profileLines(profile: ColumnProfile, rows: number): [label: string, value: string][] {
  const lines: [string, string][] = []
  const share = rows > 0 && profile.nulls > 0 ? ` (${(profile.nulls / rows * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}%)` : ''
  lines.push(['NULLs', formatCount(profile.nulls) + share])
  const unique = profile.distinctExact && profile.values > 1 && profile.distinct === profile.values
  lines.push(['Distinct', (profile.distinctExact ? '' : '≈ ') + formatCount(profile.distinct) + (unique ? ' · unique' : '')])
  if (profile.min !== undefined) lines.push(['Min', profile.min])
  if (profile.max !== undefined) lines.push(['Max', profile.max])
  if (profile.chars) lines.push(['Length', lengthText(profile.chars)])
  if (profile.bytes) lines.push(['Bytes', lengthText(profile.bytes)])
  if (profile.approximate) lines.push(['Note', 'Truncated values counted by their stored prefix'])
  return lines
}

/** What a histogram's buckets count, as its caption says. */
export const histogramCaptions: Readonly<Record<ProfileBasis, string>> = { value: 'by value', time: 'by date and time', chars: 'by length', bytes: 'by size' }

/** Each bucket's height as a percentage of the tallest; a bucket with any value is at least 6 %, so it shows. */
export function histogramHeights(counts: readonly number[]): number[] {
  const most = Math.max(0, ...counts)
  return counts.map(count => most > 0 && count > 0 ? Math.max(6, count / most * 100) : 0)
}

/** The rows' sizes in the panel's head: "Row size: largest 1.2 KB · average 312 B". */
export function rowSizeText(lengths: ProfileLengths | undefined): string | undefined {
  if (!lengths) return undefined
  return `Row size: largest ${formatSize(lengths.max)} · average ${formatSize(Math.round(lengths.average))}${lengths.exact ? '' : ' (estimated)'}`
}

/** Columns in requests of at most `size`, in order. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = []
  for (let at = 0; at < items.length; at += size) parts.push(items.slice(at, at + size))
  return parts
}

/** The cards the panel lists: every profiled column, or (`only`) those the grid's selection covers, in result order. */
export interface ProfileList { readonly columns: readonly number[]; readonly only: boolean }
/**
 * What the panel lists: Selected Columns Only (`selectedOnly`) lists the selected columns, and a peek (the gesture's
 * modifier held over the panel) shows the other list for as long as it is held.
 */
export function profileList(columns: readonly number[], selected: ReadonlySet<number>, selectedOnly: boolean, peeking: boolean): ProfileList {
  const only = selectedOnly !== peeking
  return { columns: only ? columns.filter(column => selected.has(column)) : columns, only }
}

/** The strip under the panel's head while it lists fewer than every column or peeks, or undefined. */
export function profileStrip(list: ProfileList, total: number, peeking: boolean): string | undefined {
  const count = list.columns.length
  if (peeking) return list.only ? `Peeking at ${count === 0 ? 'no' : formatCount(count)} selected ${count === 1 ? 'column' : 'columns'} · release to show all` : `Peeking at all ${formatCount(total)} columns · release to go back`
  if (!list.only) return undefined
  return count === 0 ? 'No columns selected' : `${formatCount(count)} of ${formatCount(total)} ${total === 1 ? 'column' : 'columns'}`
}

/** A comparison column's card: its changed and collation-only cells, the rows added and removed, and the rest the same. */
export interface ColumnChangeCounts { readonly changed: number; readonly soft: number; readonly added: number; readonly removed: number; readonly same: number }
/** A comparison's counts for one of its pairs (`columnChanges`, whose index is the pair's and its visible column's): an entry
 *  whose cell in it neither changed nor differs only by collation is the same there. */
export function columnChangeCounts(info: { readonly same: number; readonly changed: number; readonly added: number; readonly removed: number; readonly columnChanges: readonly { readonly changed: number; readonly soft: number }[] }, column: number): ColumnChangeCounts {
  const { changed = 0, soft = 0 } = info.columnChanges[column] ?? {}
  return { changed, soft, added: info.added, removed: info.removed, same: Math.max(0, info.same + info.changed - changed - soft) }
}
/** "3 changed · 1 added · 0 removed · 12 same", with the collation-only cells after the changed ones when there are any. */
export function columnChangeText(counts: ColumnChangeCounts): string {
  return [`${formatCount(counts.changed)} changed`, counts.soft > 0 ? `${formatCount(counts.soft)} ${counts.soft === 1 ? 'differs' : 'differ'} only by collation` : '',
    `${formatCount(counts.added)} added`, `${formatCount(counts.removed)} removed`, `${formatCount(counts.same)} same`].filter(Boolean).join(' · ')
}
/** The kinds a comparison card's bar stacks, in order, each as its share (percent) of the column's entries. */
export function columnChangeShares(counts: ColumnChangeCounts): { readonly kind: keyof ColumnChangeCounts; readonly share: number }[] {
  const kinds = ['changed', 'soft', 'added', 'removed', 'same'] as const
  const total = kinds.reduce((sum, kind) => sum + counts[kind], 0)
  return total > 0 ? kinds.filter(kind => counts[kind] > 0).map(kind => ({ kind, share: counts[kind] / total * 100 })) : []
}
