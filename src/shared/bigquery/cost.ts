/**
 * How Varia writes BigQuery's byte figures and their on-demand price (docs/bigquery.md, Cost): binary units as Google
 * bills, to two decimals, and dollars at the US on-demand rate per TiB, "< $0.01" below a cent. The backend's
 * BigQueryCost writes the same text; tests/fixtures/bigquery/cost.json pins both.
 */

/** The US multi-region's on-demand query price, in dollars per TiB. */
export const dollarsPerTiB = 6.25
const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const

/** Half away from zero at two decimals, as C#'s MidpointRounding.AwayFromZero: hundredths of a non-negative figure. */
const hundredths = (scaled: number): number => Math.floor(scaled + 0.5)

/** "0 B", "1023 B", "1.00 KiB", "1.24 GiB": bytes below a KiB whole, larger figures in the largest binary unit that keeps
 *  the number at least 1. */
export function formatBytes(bytes: number): string {
  if (!(bytes >= 1024)) return `${Math.max(0, Math.trunc(bytes || 0))} B`
  let unit = 0, divisor = 1024
  while (bytes / divisor >= 1024 && unit < units.length - 1) { divisor *= 1024; unit++ }
  let rounded = hundredths(bytes * 100 / divisor)
  // Rounding can carry a figure to 1024.00 of a unit; it is then 1.00 of the next.
  if (rounded >= 102_400 && unit < units.length - 1) { divisor *= 1024; unit++; rounded = hundredths(bytes * 100 / divisor) }
  return `${(rounded / 100).toFixed(2)} ${units[unit]}`
}

/** The on-demand price of a byte count: "$0.00" for none, "< $0.01" below a cent, else dollars to the cent with thousands
 *  separators ("$8.75", "$1,234.50"). */
export function formatDollars(bytes: number): string {
  if (!(bytes > 0)) return '$0.00'
  const dollars = bytes * dollarsPerTiB / 2 ** 40
  if (dollars < 0.01) return '< $0.01'
  const cents = hundredths(dollars * 100)
  const digits = Math.floor(cents / 100).toString()
  let whole = digits.slice(0, digits.length % 3 || 3)
  for (let at = whole.length; at < digits.length; at += 3) whole += ',' + digits.slice(at, at + 3)
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`
}

/** "1.24 GiB processed · < $0.01": the Results status's figure for a finished BigQuery job. */
export function processedFact(bytes: number): string { return `${formatBytes(bytes)} processed · ${formatDollars(bytes)}` }
