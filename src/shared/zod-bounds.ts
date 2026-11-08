import { z } from 'zod'

/** The records `boundedRecord` guards; `tests/schema-lint.test.ts` refuses any other record a schema reaches. */
export const boundedRecords = new WeakSet<z.ZodType>()

/** Whether `value` has more than `max` own enumerable keys, without listing them all. */
function overKeys(value: object, max: number): boolean {
  let count = 0
  for (const key in value) if (Object.hasOwn(value, key) && ++count > max) return true
  return false
}

/**
 * `record` behind a key count checked before zod parses any key. Zod caps arrays, sets and maps before their elements
 * (4.6.6, GHSA-mrhx-c7xc-m3w5) but not records: it parses every key and a refinement adds an issue per key, so a page that
 * sent 200,000 keys would hold main for most of a second before the refusal. The pipe stops at the count's failure.
 */
export function boundedRecord<Record extends z.ZodRecord>(record: Record, maxKeys: number, message = `At most ${maxKeys} entries.`) {
  boundedRecords.add(record)
  return z.custom<unknown>(value => typeof value !== 'object' || value === null || !overKeys(value, maxKeys), message).pipe(record)
}
