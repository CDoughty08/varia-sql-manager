import { z } from 'zod'
import { bigQueryDatasetSchema } from '../connections'
import { formatBytes, formatDollars } from './cost'
import { remoteDryRunSchema, type RemoteDryRun } from './remote-view'

/**
 * bigquery.dryRun (docs/bigquery.md, Cost): the free estimate a BigQuery query tab shows beside Execute, the prompts before
 * Execute, and the editor's dry-run diagnostics. BigQueryService.DryRunQueryAsync (C#) checks the same limits.
 */
export const dryRunLimits = { characters: 1_000_000 } as const

/** Why an estimate may be lower than what the query will process. */
export const incompleteReasons = ['script', 'lowerBound', 'unknown', 'zeroBytes'] as const
export type IncompleteReason = typeof incompleteReasons[number]

/**
 * Editor text with the tab's dataset, or a results.remoteQuery request to estimate (docs/bigquery.md, Sort and filter in BigQuery).
 * `sessionId` is the tab's (query.execute's): when the tab already has a BigQuery session the text is dry-run in it, so its
 * temp tables and variables resolve. The backend never creates a session for an estimate.
 */
export type BigQueryDryRunRequest = { connectionId: string; sql: string; dataset?: string; noDefaultDataset?: true; sessionId?: string } | { connectionId: string; remote: RemoteDryRun }
export interface BigQueryDryRunResult {
  bytesProcessed: number
  incomplete?: IncompleteReason
  statementType?: string
  /** Emulator mode: the emulator does not dry-run, so the backend answers 0 bytes. */
  faked?: boolean
  /** A remote estimate whose result table expired: the figure is the original query's, run again with the clauses around it. */
  fallback?: true
}

export const bigQueryDryRunRequestSchema = z.union([
  z.object({ connectionId: z.uuid(), sql: z.string().min(1).max(dryRunLimits.characters), dataset: bigQueryDatasetSchema.optional(), noDefaultDataset: z.literal(true).optional(), sessionId: z.uuid().optional() }).strict()
    .refine(params => !(params.dataset !== undefined && params.noDefaultDataset), 'A dry run cannot name both a dataset and no default dataset.'),
  z.object({ connectionId: z.uuid(), remote: remoteDryRunSchema }).strict()
])
export const bigQueryDryRunResultSchema = z.object({
  bytesProcessed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), incomplete: z.enum(incompleteReasons).optional(),
  statementType: z.string().max(64).regex(/^[A-Z_]+$/).optional(), faked: z.boolean().optional(), fallback: z.literal(true).optional()
}).strict()

/** Why the figure may be low, for the incomplete-estimate prompt and the chip's tooltip. */
export const incompleteText: Readonly<Record<IncompleteReason, string>> = {
  script: 'This is a script: BigQuery estimates it only up to its first DDL or control statement (such as CREATE, DECLARE, IF or LOOP), so later statements are not counted.',
  lowerBound: 'BigQuery reports this estimate as a lower bound: the query may process more.',
  unknown: 'BigQuery could not estimate this query accurately.',
  zeroBytes: 'The query reads tables but the estimate is 0 bytes. That is right for an empty table, partitions the query skips or a count BigQuery answers from table metadata, but external tables and tables with row-level security also report no bytes before they run.'
}

/** "1.24 GiB · < $0.01", or bytes alone when prices are off (Query Execution › BigQuery › Cost › Show cost as). */
export function pricedBytes(bytes: number, prices: boolean): string { return prices ? `${formatBytes(bytes)} · ${formatDollars(bytes)}` : formatBytes(bytes) }

/** The bytes of a whole number of GiB (the Cost page's threshold and cap), or undefined for 0 (none). */
export function gibibytes(value: number): number | undefined { return value > 0 ? value * 2 ** 30 : undefined }

/**
 * BigQuery's position in a query error ("Unrecognized name: x at [5:7]"): its 1-based line and column, the last one in
 * the message (a nested error names the outer statement first). Undefined when the message has none.
 */
export function errorPosition(message: string): { line: number; column: number } | undefined {
  let found: { line: number; column: number } | undefined
  for (const match of message.matchAll(/\[(\d{1,7}):(\d{1,7})\]/g)) {
    const line = Number(match[1]), column = Number(match[2])
    if (line >= 1 && column >= 1) found = { line, column }
  }
  return found
}

export type CostPrompt = { readonly kind: 'threshold'; readonly bytes: number } | { readonly kind: 'incomplete'; readonly bytes: number; readonly reason: IncompleteReason }

export interface CostPromptRules {
  /** Ask above the threshold (Cost › Ask before running…), and not turned off for this connection. */
  readonly askAboveThreshold: boolean
  /** The threshold in bytes. */
  readonly thresholdBytes: number
  /** Cost › Warn about incomplete estimates (`incompleteEstimateWarning`). */
  readonly warnIncomplete: boolean
}

/**
 * Whether Execute asks before running, so a costly job never starts unseen: above the threshold, or when the estimate may be low and the user has
 * not turned that warning off. Above the threshold wins: its prompt already names the figure. A faked estimate (emulator)
 * never asks.
 */
export function costPrompt(estimate: BigQueryDryRunResult, rules: CostPromptRules): CostPrompt | undefined {
  if (estimate.faked) return undefined
  if (rules.askAboveThreshold && estimate.bytesProcessed > rules.thresholdBytes) return { kind: 'threshold', bytes: estimate.bytesProcessed }
  if (rules.warnIncomplete && estimate.incomplete) return { kind: 'incomplete', bytes: estimate.bytesProcessed, reason: estimate.incomplete }
  return undefined
}
