import { formatBytes as formatBillingBytes, formatDollars } from '../../../shared/bigquery/cost'
import { remoteViewLimits, type SampleMethod } from '../../../shared/bigquery/remote-view'
import { formatBytes, formatCount } from './status'

/**
 * Load sample's words and arithmetic (docs/bigquery.md, Load a sample): the sample's name, which it keeps on everything built
 * from it, the rows the dialog offers first, and its note on what the sample costs in bytes billed and in result memory.
 */

/** A sample's name, shown wherever its result is ("Sample: 1,000,000 of 52,341,118 rows"), and in the names of what is
 *  built from it ("Pivot of Sample: …", "Differences: Sample: … → Result 1", the Column Profile's title). */
export const sampleName = (rows: number, total: number): string => `Sample: ${formatCount(rows)} of ${formatCount(total)} ${total === 1 ? 'row' : 'rows'}`

/** The rows Load sample offers first: a million, or fewer when the result has fewer or a million would not fit in half the
 *  result memory free (`rowBytes`, a row's projected size), never fewer than one. */
export function defaultSampleRows(total: number, rowBytes: number | undefined, freeBytes: number | undefined): number {
  let rows = Math.min(1_000_000, Math.max(1, total), remoteViewLimits.sampleRows)
  if (rowBytes && rowBytes > 0 && freeBytes !== undefined) rows = Math.min(rows, Math.max(1, Math.floor(freeBytes / 2 / rowBytes)))
  // A round figure reads better than an arbitrary one: down to two significant digits.
  if (rows > 100) { const scale = 10 ** (Math.floor(Math.log10(rows)) - 1); rows = Math.floor(rows / scale) * scale }
  return rows
}

/** The rows typed in the dialog, as a count from 1 to the most a sample takes (and no more than the result has), or
 *  undefined when the text is not one. Digits only, with thousands separators allowed. */
export function parseSampleRows(text: string, total: number): number | undefined {
  const digits = text.trim().replace(/[,\s_]/g, '')
  if (!/^\d{1,9}$/.test(digits)) return undefined
  const rows = Number(digits)
  return rows >= 1 && rows <= Math.min(remoteViewLimits.sampleRows, Math.max(1, total)) ? rows : undefined
}

/** The most rows the dialog takes for a result of `total` rows. */
export const maxSampleRows = (total: number): number => Math.min(remoteViewLimits.sampleRows, Math.max(1, total))

/** A row's projected size in memory, from a windowed result's projection: undefined when it has none. */
export const rowBytesOf = (projectedBytes: number | undefined, total: number): number | undefined => projectedBytes && total > 0 ? projectedBytes / total : undefined

/** What a random sample's estimate says: bytes BigQuery would process (with their price), or that it is being worked out or
 *  could not be. */
export type SampleEstimate = { readonly state: 'estimating' } | { readonly state: 'failed'; readonly reason: string } | { readonly state: 'done'; readonly bytes: number; readonly incomplete: boolean }

/** The dialog's note: what the sample costs to make (nothing for the first rows; the estimate for a random one), and the
 *  result memory it needs beside what is free. */
export function sampleNote(o: { method: SampleMethod; rows: number | undefined; rowBytes: number | undefined; freeBytes: number | undefined; estimate?: SampleEstimate; prices: boolean }): string {
  const cost = o.method === 'first' ? 'The first rows are free: tabledata.list reads them, and no job runs.'
    : !o.estimate || o.estimate.state === 'estimating' ? 'Estimating what the random sample processes…'
      : o.estimate.state === 'failed' ? `The random sample could not be estimated: ${o.estimate.reason}`
        : `The random sample processes about ${formatBillingBytes(o.estimate.bytes)}${o.prices ? ` (about ${formatDollars(o.estimate.bytes)})` : ''}${o.estimate.incomplete ? ', which may be low' : ''}. BigQuery bills only the blocks it reads.`
  if (o.rows === undefined || !o.rowBytes) return cost
  const need = o.rows * o.rowBytes
  return `${cost} The sample needs about ${formatBytes(need)} of result memory${o.freeBytes === undefined ? '.' : `, of ${formatBytes(o.freeBytes)} free.`}`
}

/** The line beside Load and Cancel: the result the first rows make, by name, or what a random sample makes (its rows are
 *  BigQuery's pick, so up to the rows asked). */
export const sampleStatus = (method: SampleMethod, rows: number, total: number): string =>
  method === 'first' ? `Creates “${sampleName(Math.min(rows, total), total)}”` : `Creates a sample of up to ${formatCount(Math.min(rows, total))} of ${formatCount(total)} rows`

/** Whether the sample would not fit in the result memory free: it would be cut short there, so the dialog says so. */
export const sampleTooLarge = (rows: number | undefined, rowBytes: number | undefined, freeBytes: number | undefined): boolean =>
  rows !== undefined && !!rowBytes && freeBytes !== undefined && rows * rowBytes > freeBytes
