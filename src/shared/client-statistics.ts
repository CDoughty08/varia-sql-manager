import { z } from 'zod'

/** The documented SqlClient keys we understand. Missing keys and unsafe values stay unavailable. */
export const providerMetricDefinitions = [
  ['BytesSent', 'Bytes sent', 'Bytes sent in TDS packets; excludes login, session setup and observer connections.'],
  ['BytesReceived', 'Bytes received', 'Bytes received in TDS packets, including metadata, messages and any user-requested XML plans.'],
  ['BuffersSent', 'TDS packets sent', 'Provider TDS buffers sent; these are not TCP packets.'],
  ['BuffersReceived', 'TDS packets received', 'Provider TDS buffers received; these are not TCP packets.'],
  ['ServerRoundtrips', 'Server round trips', 'Provider command/reply round trips; a large response can contain many packets.'],
  ['SelectCount', 'SELECT statements', 'Provider SELECT completion tokens, including cursor fetches; not a SQL text statement count.'],
  ['SelectRows', 'SELECT rows', 'Rows reported by SELECT completion tokens. NOCOUNT, errors and cancellation can suppress counts; not rows rendered.'],
  ['IduCount', 'INSERT / DELETE / UPDATE statements', 'Provider DML completion tokens, not a SQL parser count.'],
  ['IduRows', 'INSERT / DELETE / UPDATE rows', 'Affected rows reported by DML completion tokens; NOCOUNT can suppress them.'],
  ['SumResultSets', 'Result sets', 'Result sets seen by the provider, including sets omitted by display limits.'],
  ['Transactions', 'Transactions', 'Provider transaction tokens, including auto-commit commands. Not the open transaction count.'],
  ['CursorOpens', 'Cursor opens', 'Server cursor opens; forward-only SELECT readers are not cursors.'],
  ['Prepares', 'Prepares', 'Provider prepared-command operations.'],
  ['PreparedExecs', 'Prepared executions', 'Provider executions of prepared commands.'],
  ['UnpreparedExecs', 'Unprepared executions', 'Provider executions of unprepared commands.'],
  ['ExecutionTime', 'Provider processing time (ms)', 'Unavailable: SqlClient does not reliably time the asynchronous ExecuteReader path used by Varia. A zero or partial value would be misleading.'],
  ['NetworkServerTime', 'Provider reply wait (ms)', 'Time the provider waits for server replies. Includes network and server work; does not separate them. Millisecond resolution can report zero.']
] as const
export type ProviderMetric = typeof providerMetricDefinitions[number][0]
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const clientStatisticsSchema = z.object({
  counters: z.object(Object.fromEntries(providerMetricDefinitions.map(([key]) => [key, counter.optional()])) as Record<ProviderMetric, z.ZodOptional<typeof counter>>).strict(),
  collectionElapsedMs: counter.optional(), unavailable: z.string().max(256).optional()
}).strict()
export interface ClientStatisticsSample {
  readonly counters: Partial<Record<ProviderMetric, number>>
  readonly collectionElapsedMs?: number
  readonly unavailable?: string
}
export const clientStatisticsHistoryLimit = 10
