/** SQL Server's `sysname` length, in UTF-16 code units. */
export const maxIdentifierLength = 128
/** The longest Select Top script that lists columns; a longer one selects `*` instead. */
export const maxSelectTopScriptLength = 1_000_000

/** `QUOTENAME`: the name in brackets with every `]` doubled. Throws for an empty name or one longer than `sysname`. */
export function quoteName(name: string): string {
  if (!name) throw new Error('A name cannot be empty.')
  if (name.length > maxIdentifierLength) throw new Error(`A name is limited to ${maxIdentifierLength} characters.`)
  return '[' + name.replaceAll(']', ']]') + ']'
}

export interface SelectTopRowsSource {
  readonly database: string
  readonly schema: string
  readonly name: string
  readonly columns: readonly { readonly name: string }[]
  /** The column list was cut short, so it cannot be spelled out. */
  readonly truncated: boolean
}
/**
 * SSMS's Select Top N Rows script: the columns in table order, one per line with a leading comma, from the table's
 * three-part name. It selects `*` when the column list is incomplete, empty, or would make the script too long.
 */
export function selectTopRowsScript(source: SelectTopRowsSource, count = 1000): string {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('The row count must be a positive integer.')
  const header = '/****** Script for SelectTopNRows command from Varia SQL Manager ******/'
  const from = `  FROM ${quoteName(source.database)}.${quoteName(source.schema)}.${quoteName(source.name)}`
  const star = [header, `SELECT TOP (${count}) *`, from].join('\n')
  if (source.truncated || !source.columns.length) return star
  const lines = [header, ...source.columns.map((column, index) => (index ? '      ,' : `SELECT TOP (${count}) `) + quoteName(column.name)), from]
  const script = lines.join('\n')
  return script.length > maxSelectTopScriptLength ? star : script
}
