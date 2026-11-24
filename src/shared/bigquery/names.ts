// BigQuery's name rules per kind (docs/bigquery.md, Object Explorer), checked in zod and again in C#
// (BqNames), and the backtick quoting Copy Name and drag use. Erasable TypeScript with no imports outside .ts files, so the
// Explorer catalogue (loaded by Node's type stripping) can import it.

/** The kinds of BigQuery name, each with its own rule and length. */
export const bigQueryNameKinds = ['project', 'dataset', 'table', 'routine', 'model', 'column'] as const
export type BigQueryNameKind = typeof bigQueryNameKinds[number]

/**
 * Projects: Google's project id grammar, a domain-scoped `example.com:proj` included, up to 128 characters. Datasets, routines
 * and models: letters, digits and underscores (1,024, 256 and 1,024 characters). Tables: Unicode letters, marks, numbers,
 * connectors, dashes and spaces, up to 1,024 UTF-8 bytes. Columns: the flexible column-name set (those classes and
 * `& % = + : ' < > # |`), up to 300 characters, never starting with a reserved prefix BigQuery refuses (not checked here: the
 * names come from BigQuery). None of them can hold a backtick, a backslash, a dot or a line break.
 */
export const bigQueryNameRules: { readonly [K in BigQueryNameKind]: { readonly pattern: RegExp; readonly max: number; readonly bytes?: true } } = {
  project: { pattern: /^(?:[a-z\d][a-z\d.-]{0,61}[a-z\d]:)?[a-z][a-z\d-]{4,28}[a-z\d]$/, max: 128 },
  dataset: { pattern: /^\w+$/, max: 1024 },
  table: { pattern: /^[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Zs}]+$/u, max: 1024, bytes: true },
  routine: { pattern: /^\w+$/, max: 256 },
  model: { pattern: /^\w+$/, max: 1024 },
  column: { pattern: /^[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Zs}&%=+:'<>#|]+$/u, max: 300 }
}
/** BigQuery nests STRUCT fields at most 15 deep. */
export const bigQueryFieldDepth = 15
/** The longest column path a ref carries: 15 parts of 300 characters joined by dots. */
export const bigQueryFieldPathMax = bigQueryFieldDepth * bigQueryNameRules.column.max + bigQueryFieldDepth - 1

const utf8Length = (value: string): number => new TextEncoder().encode(value).length

/** Whether `value` is a name of this kind. */
export function isBigQueryName(kind: BigQueryNameKind, value: string): boolean {
  const rule = bigQueryNameRules[kind]
  if (value.length === 0 || value.length > rule.max || (rule.bytes && utf8Length(value) > rule.max)) return false
  return rule.pattern.test(value)
}

/** Whether `value` is a column path: 1 to 15 column names joined by dots. */
export function isBigQueryFieldPath(value: string): boolean {
  const parts = value.split('.')
  return parts.length <= bigQueryFieldDepth && parts.every(part => isBigQueryName('column', part))
}

/** A backtick-quoted identifier: backslashes and backticks escaped, as GoogleSQL reads quoted identifiers. */
export function quoteBigQuery(text: string): string { return '`' + text.replace(/[\\`]/g, char => '\\' + char) + '`' }

/** A dataset object's full name as one quoted path, `` `project.dataset.table` ``, or a project's or dataset's prefix of it. */
export function bigQueryPath(...parts: readonly string[]): string { return quoteBigQuery(parts.join('.')) }

/** A column path as Copy Name writes it: each part quoted, so a reserved word or a flexible name reads as a name. */
export function bigQueryFieldText(path: string): string { return path.split('.').map(quoteBigQuery).join('.') }
