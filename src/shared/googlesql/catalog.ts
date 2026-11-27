// The GoogleSQL words and functions the editor knows: the tokenizer colours them (languages/googlesql.ts), signature
// help shows the functions' signatures, and BigQuery's completion (docs/language-services.md, Completion from the index) lists them. Built by
// hand from Google's public GoogleSQL reference for BigQuery, never from queries. docs/googlesql.md is generated from
// this file: after changing it run `npx vitest run tests/googlesql-catalog.test.ts -u`.

/** Reserved keywords: GoogleSQL refuses them as unquoted identifiers (Lexical structure › Reserved keywords). */
export const googleSqlReservedKeywords = [
  'ALL', 'AND', 'ANY', 'ARRAY', 'AS', 'ASC', 'ASSERT_ROWS_MODIFIED', 'AT', 'BETWEEN', 'BY', 'CASE', 'CAST', 'COLLATE', 'CONTAINS', 'CREATE', 'CROSS', 'CUBE',
  'CURRENT', 'DEFAULT', 'DEFINE', 'DESC', 'DISTINCT', 'ELSE', 'END', 'ENUM', 'ESCAPE', 'EXCEPT', 'EXCLUDE', 'EXISTS', 'EXTRACT', 'FALSE', 'FETCH', 'FOLLOWING',
  'FOR', 'FROM', 'FULL', 'GROUP', 'GROUPING', 'GROUPS', 'HASH', 'HAVING', 'IF', 'IGNORE', 'IN', 'INNER', 'INTERSECT', 'INTERVAL', 'INTO', 'IS', 'JOIN', 'LATERAL',
  'LEFT', 'LIKE', 'LIMIT', 'LOOKUP', 'MERGE', 'NATURAL', 'NEW', 'NO', 'NOT', 'NULL', 'NULLS', 'OF', 'ON', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION',
  'PRECEDING', 'PROTO', 'QUALIFY', 'RANGE', 'RECURSIVE', 'RESPECT', 'RIGHT', 'ROLLUP', 'ROWS', 'SELECT', 'SET', 'SOME', 'STRUCT', 'TABLESAMPLE', 'THEN', 'TO',
  'TREAT', 'TRUE', 'UNBOUNDED', 'UNION', 'UNNEST', 'USING', 'WHEN', 'WHERE', 'WINDOW', 'WITH', 'WITHIN'
] as const

/** Words with a meaning in statements, DDL, DML and scripting that GoogleSQL still accepts as identifiers. */
export const googleSqlKeywords = [
  'ABORT', 'ACCESS', 'ACTION', 'ADD', 'AFTER', 'AGGREGATE', 'ALTER', 'ANALYZE', 'ASSERT', 'BEGIN', 'BREAK', 'CALL', 'CASCADE', 'CHECK', 'CLONE', 'CLUSTER',
  'COLUMN', 'COLUMNS', 'COMMIT', 'CONNECTION', 'CONSTANT', 'CONSTRAINT', 'CONTINUE', 'COPY', 'CYCLE', 'DATA', 'DECLARE', 'DELETE', 'DESCRIBE', 'DETERMINISTIC',
  'DO', 'DROP', 'ELSEIF', 'ENFORCED', 'EXCEPTION', 'EXECUTE', 'EXPLAIN', 'EXPORT', 'EXTERNAL', 'FILES', 'FILTER', 'FIRST', 'FOREIGN', 'FUNCTION', 'GRANT',
  'IMMEDIATE', 'INDEX', 'INOUT', 'INSERT', 'ITERATE', 'KEY', 'LANGUAGE', 'LAST', 'LEAVE', 'LOAD', 'LOOP', 'MATCHED', 'MATERIALIZED', 'MESSAGE', 'MODEL',
  'OFFSET', 'OPTIONS', 'ORDINAL', 'OUT', 'OVERWRITE', 'PERCENT', 'PIVOT', 'POLICY', 'PRIMARY', 'PRIVILEGES', 'PROCEDURE', 'RAISE', 'REFERENCES', 'RENAME',
  'REPEAT', 'REPLACE', 'REPLICA', 'RESERVATION', 'RESTRICT', 'RETURN', 'RETURNS', 'REVOKE', 'ROLLBACK', 'ROW', 'SAFE', 'SAFE_OFFSET', 'SAFE_ORDINAL',
  'SCHEMA', 'SEARCH', 'SECURITY', 'SNAPSHOT', 'SOURCE', 'SQL', 'SYSTEM', 'SYSTEM_TIME', 'TABLE', 'TARGET', 'TEMP', 'TEMPORARY', 'TRANSACTION', 'TRUNCATE',
  'UNDROP', 'UNPIVOT', 'UNTIL', 'UPDATE', 'VALUE', 'VALUES', 'VIEW', 'WHILE', 'ZONE'
] as const

/** Data type names, with their aliases. */
export const googleSqlTypes = [
  'BIGDECIMAL', 'BIGINT', 'BIGNUMERIC', 'BOOL', 'BOOLEAN', 'BYTEINT', 'BYTES', 'DATE', 'DATETIME', 'DECIMAL', 'FLOAT64', 'GEOGRAPHY', 'INT', 'INT64', 'INTEGER',
  'JSON', 'NUMERIC', 'SMALLINT', 'STRING', 'TIME', 'TIMESTAMP', 'TINYINT'
] as const

/** Keywords coloured as operators, as the Transact-SQL tokenizer colours its own: logic, set operations and joins. */
export const googleSqlOperatorWords = [
  'ALL', 'AND', 'ANY', 'BETWEEN', 'CROSS', 'EXCEPT', 'EXISTS', 'FULL', 'IN', 'INNER', 'INTERSECT', 'IS', 'JOIN', 'LEFT', 'LIKE', 'NATURAL', 'NOT', 'OR', 'OUTER',
  'RIGHT', 'SOME', 'UNION'
] as const

/** Functions GoogleSQL also accepts without parentheses (`SELECT CURRENT_DATE`). */
export const googleSqlNiladicFunctions = ['CURRENT_DATE', 'CURRENT_DATETIME', 'CURRENT_TIME', 'CURRENT_TIMESTAMP'] as const

/** Date/time part granularities accepted by EXTRACT and *_TRUNC/*_DIFF/LAST_DAY functions. */
export const googleSqlDateParts = [
  'YEAR', 'ISOYEAR', 'QUARTER', 'MONTH', 'WEEK', 'ISOWEEK', 'DAY', 'DAYOFWEEK', 'DAYOFYEAR',
  'HOUR', 'MINUTE', 'SECOND', 'MILLISECOND', 'MICROSECOND', 'DATE', 'DATETIME', 'TIME'
] as const
export type GoogleSqlDatePart = typeof googleSqlDateParts[number]

const datePartsDate: readonly GoogleSqlDatePart[] = ['DAY', 'WEEK', 'ISOWEEK', 'MONTH', 'QUARTER', 'YEAR', 'ISOYEAR']
const datePartsTime: readonly GoogleSqlDatePart[] = ['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR']
const datePartsDateTime: readonly GoogleSqlDatePart[] = ['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'ISOWEEK', 'MONTH', 'QUARTER', 'YEAR', 'ISOYEAR']
const datePartsTimestampDiff: readonly GoogleSqlDatePart[] = ['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY']
const datePartsLastDay: readonly GoogleSqlDatePart[] = ['YEAR', 'ISOYEAR', 'QUARTER', 'MONTH', 'WEEK', 'ISOWEEK']

const datePartsByFunction: Readonly<Record<string, readonly GoogleSqlDatePart[]>> = {
  EXTRACT: googleSqlDateParts,
  DATE_TRUNC: datePartsDate,
  DATE_DIFF: datePartsDate,
  DATETIME_TRUNC: datePartsDateTime,
  DATETIME_DIFF: datePartsDateTime,
  TIMESTAMP_TRUNC: datePartsDateTime,
  TIMESTAMP_DIFF: datePartsTimestampDiff,
  TIME_TRUNC: datePartsTime,
  TIME_DIFF: datePartsTime,
  LAST_DAY: datePartsLastDay
}

/** Valid GoogleSQL date/time parts for a function (case-insensitive, `SAFE.` prefix stripped), or all date parts when unspecified. */
export function googleSqlDatePartsFor(functionName?: string): readonly GoogleSqlDatePart[] {
  if (!functionName) return googleSqlDateParts
  const key = functionName.toUpperCase().replace(/^SAFE\./, '')
  return datePartsByFunction[key] ?? googleSqlDateParts
}

/** Curated BigQuery scripting and session system variables (`@@...`). */
export interface GoogleSqlSystemVariable {
  readonly name: string
  readonly type: string
  readonly readOnly: boolean
  readonly summary: string
}

export const googleSqlSystemVariables: readonly GoogleSqlSystemVariable[] = [
  { name: '@@dataset_id', type: 'STRING', readOnly: false, summary: 'Default dataset for unqualified table names in the script.' },
  { name: '@@dataset_project_id', type: 'STRING', readOnly: false, summary: 'Default project for unqualified table names in the script.' },
  { name: '@@project_id', type: 'STRING', readOnly: true, summary: 'Project ID executing the current query or script.' },
  { name: '@@query_label', type: 'STRING', readOnly: false, summary: 'Key-value labels attached to jobs run by the script.' },
  { name: '@@time_zone', type: 'STRING', readOnly: false, summary: 'Default time zone for date and time operations.' },
  { name: '@@last_job_id', type: 'STRING', readOnly: true, summary: 'Job ID of the most recently executed child job in the script.' },
  { name: '@@row_count', type: 'INT64', readOnly: true, summary: 'Number of rows modified by the most recent DML statement.' },
  { name: '@@error.formatted_stack_trace', type: 'STRING', readOnly: true, summary: 'Formatted stack trace of the most recent exception.' },
  { name: '@@error.message', type: 'STRING', readOnly: true, summary: 'Error message of the most recent exception.' },
  { name: '@@error.stack_trace', type: 'ARRAY<STRUCT>', readOnly: true, summary: 'Structured stack frames of the most recent exception.' },
  { name: '@@error.statement_text', type: 'STRING', readOnly: true, summary: 'SQL text of the statement that raised the most recent exception.' },
  { name: '@@script.bytes_billed', type: 'INT64', readOnly: true, summary: 'Total bytes billed across all completed jobs in the script.' },
  { name: '@@script.bytes_processed', type: 'INT64', readOnly: true, summary: 'Total bytes processed across all completed jobs in the script.' },
  { name: '@@script.creation_time', type: 'TIMESTAMP', readOnly: true, summary: 'Timestamp when the script began executing.' },
  { name: '@@script.job_id', type: 'STRING', readOnly: true, summary: 'Job ID of the running script.' },
  { name: '@@script.num_child_jobs', type: 'INT64', readOnly: true, summary: 'Number of child jobs executed by the script so far.' },
  { name: '@@script.slot_ms', type: 'INT64', readOnly: true, summary: 'Total slot-milliseconds consumed by the script.' },
  { name: '@@script.statement_text', type: 'STRING', readOnly: true, summary: 'SQL text of the currently executing statement in the script.' }
]

/** Curated BigQuery `INFORMATION_SCHEMA` metadata views and their dataset/region scopes. */
export type GoogleSqlInfoSchemaScope = 'dataset' | 'region' | 'both'
export interface GoogleSqlInfoSchemaView {
  readonly name: string
  readonly scope: GoogleSqlInfoSchemaScope
  readonly summary: string
}

export const googleSqlInformationSchemaViews: readonly GoogleSqlInfoSchemaView[] = [
  { name: 'TABLES', scope: 'both', summary: 'Metadata for tables, views, materialized views and external tables.' },
  { name: 'TABLE_OPTIONS', scope: 'both', summary: 'Options configured on tables and views.' },
  { name: 'COLUMNS', scope: 'both', summary: 'Top-level column names, data types, ordinals and nullability.' },
  { name: 'COLUMN_FIELD_PATHS', scope: 'both', summary: 'Nested STRUCT field paths, data types, descriptions and policy tags.' },
  { name: 'VIEWS', scope: 'both', summary: 'SQL definitions of views in the dataset or region.' },
  { name: 'MATERIALIZED_VIEWS', scope: 'both', summary: 'SQL definitions and refresh metadata for materialized views.' },
  { name: 'PARTITIONS', scope: 'both', summary: 'Partition IDs, row counts and storage sizes for partitioned tables.' },
  { name: 'TABLE_STORAGE', scope: 'both', summary: 'Active, long-term, logical and physical storage bytes per table.' },
  { name: 'TABLE_STORAGE_BY_ORGANIZATION', scope: 'region', summary: 'Table storage usage across every project in the organization.' },
  { name: 'TABLE_STORAGE_TIMELINE', scope: 'both', summary: 'Daily historical storage usage per table.' },
  { name: 'ROUTINES', scope: 'both', summary: 'Metadata and definitions for UDFs, table functions and stored procedures.' },
  { name: 'ROUTINE_OPTIONS', scope: 'both', summary: 'Options configured on routines.' },
  { name: 'PARAMETERS', scope: 'both', summary: 'Input and output parameters of routines.' },
  { name: 'TABLE_CONSTRAINTS', scope: 'both', summary: 'Primary key and foreign key constraints defined on tables.' },
  { name: 'KEY_COLUMN_USAGE', scope: 'both', summary: 'Columns participating in primary key or foreign key constraints.' },
  { name: 'SCHEMATA', scope: 'region', summary: 'Datasets in the project and region.' },
  { name: 'SCHEMATA_OPTIONS', scope: 'region', summary: 'Options configured on datasets in the project and region.' },
  { name: 'JOBS_BY_PROJECT', scope: 'region', summary: 'Near real-time metadata for jobs submitted in the project.' },
  { name: 'JOBS_BY_USER', scope: 'region', summary: 'Metadata for jobs submitted by the current user in the project.' },
  { name: 'JOBS_BY_FOLDER', scope: 'region', summary: 'Metadata for jobs submitted in a Google Cloud folder.' },
  { name: 'JOBS_BY_ORGANIZATION', scope: 'region', summary: 'Metadata for jobs submitted across the organization.' },
  { name: 'JOBS_TIMELINE_BY_PROJECT', scope: 'region', summary: 'Per-second slot usage and job activity timeline in the project.' },
  { name: 'SESSIONS_BY_PROJECT', scope: 'region', summary: 'Active and recent BigQuery sessions in the project.' },
  { name: 'SESSIONS_BY_USER', scope: 'region', summary: 'Active and recent BigQuery sessions for the current user.' },
  { name: 'RESERVATIONS', scope: 'region', summary: 'Slot reservations configured in the administration project.' },
  { name: 'RESERVATION_ASSIGNMENTS', scope: 'region', summary: 'Project, folder and organization assignments to slot reservations.' },
  { name: 'SEARCH_INDEXES', scope: 'both', summary: 'Search indexes defined on tables.' },
  { name: 'SEARCH_INDEX_COLUMNS', scope: 'both', summary: 'Columns covered by search indexes.' },
  { name: 'VECTOR_INDEXES', scope: 'both', summary: 'Vector indexes defined on tables.' },
  { name: 'OBJECT_PRIVILEGES', scope: 'both', summary: 'Access privileges granted on datasets, tables and routines.' }
]

/** The function reference's sections, in its order. */
export const googleSqlCategories = {
  aggregate: 'Aggregate',
  approximate: 'Approximate aggregate',
  array: 'Array',
  bit: 'Bit',
  conditional: 'Conditional expressions',
  conversion: 'Conversion',
  date: 'Date',
  datetime: 'Datetime',
  time: 'Time',
  timestamp: 'Timestamp',
  interval: 'Interval',
  debugging: 'Debugging',
  encryption: 'AEAD encryption',
  geography: 'Geography',
  hash: 'Hash',
  hll: 'HyperLogLog++',
  json: 'JSON',
  math: 'Mathematical',
  navigation: 'Navigation',
  net: 'Net',
  numbering: 'Numbering',
  range: 'Range',
  search: 'Search',
  security: 'Security',
  statistical: 'Statistical aggregate',
  string: 'String',
  utility: 'Utility'
} as const
export type GoogleSqlCategory = keyof typeof googleSqlCategories

/**
 * One way to call a function. `parameters` are shown as written: an optional one in brackets (`[length]`), and `...`
 * for "more of the one before". A parameter can hold its own syntax (`expression AS type`), since signature help counts
 * only the commas between arguments.
 */
export interface GoogleSqlSignature { readonly parameters: readonly string[]; readonly returns: string }
export interface GoogleSqlFunction {
  /** Upper case, with its namespace where it has one (`NET.HOST`). */
  readonly name: string
  readonly category: GoogleSqlCategory
  /** One sentence, in Varia's words. */
  readonly summary: string
  readonly signatures: readonly GoogleSqlSignature[]
}

/** `parameters` as one comma-separated string: commas inside parentheses, brackets or angle brackets do not split it. */
const s = (parameters: string, returns: string): GoogleSqlSignature => ({ parameters: splitParameters(parameters), returns })
function splitParameters(text: string): string[] {
  const parts: string[] = []
  let depth = 0, start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '<') depth++
    else if (char === ')' || char === ']' || char === '>') depth--
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1 }
  }
  const last = text.slice(start).trim()
  if (last) parts.push(last)
  return parts
}
const f = (category: GoogleSqlCategory, name: string, summary: string, ...signatures: GoogleSqlSignature[]): GoogleSqlFunction => ({ name, category, summary, signatures })

export const googleSqlFunctions: readonly GoogleSqlFunction[] = [
  // Aggregate
  f('aggregate', 'ANY_VALUE', 'Returns the expression\'s value for some row of the group.', s('expression [HAVING {MAX | MIN} expression2]', 'type of expression')),
  f('aggregate', 'ARRAY_AGG', 'Collects the values of a group into an array.', s('[DISTINCT] expression [{IGNORE | RESPECT} NULLS] [ORDER BY key] [LIMIT n]', 'ARRAY')),
  f('aggregate', 'ARRAY_CONCAT_AGG', 'Concatenates the arrays of a group into one array.', s('expression [ORDER BY key] [LIMIT n]', 'ARRAY')),
  f('aggregate', 'AVG', 'Returns the average of the non-NULL values.', s('[DISTINCT] expression', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('aggregate', 'BIT_AND', 'Returns the bitwise AND of the values.', s('[DISTINCT] expression', 'INT64')),
  f('aggregate', 'BIT_OR', 'Returns the bitwise OR of the values.', s('[DISTINCT] expression', 'INT64')),
  f('aggregate', 'BIT_XOR', 'Returns the bitwise XOR of the values.', s('[DISTINCT] expression', 'INT64')),
  f('aggregate', 'COUNT', 'Counts the rows, or the non-NULL values of an expression.', s('*', 'INT64'), s('[DISTINCT] expression', 'INT64')),
  f('aggregate', 'COUNTIF', 'Counts the rows for which the condition is TRUE.', s('[DISTINCT] expression', 'INT64')),
  f('aggregate', 'GROUPING', 'Tells whether a GROUP BY column is aggregated (1) in this row of a ROLLUP, CUBE or GROUPING SETS.', s('groupable_value', 'INT64')),
  f('aggregate', 'LOGICAL_AND', 'Returns TRUE when every non-NULL value is TRUE.', s('expression', 'BOOL')),
  f('aggregate', 'LOGICAL_OR', 'Returns TRUE when any non-NULL value is TRUE.', s('expression', 'BOOL')),
  f('aggregate', 'MAX', 'Returns the largest non-NULL value.', s('expression', 'type of expression')),
  f('aggregate', 'MAX_BY', 'Returns x from the row with the largest y.', s('x, y', 'type of x')),
  f('aggregate', 'MIN', 'Returns the smallest non-NULL value.', s('expression', 'type of expression')),
  f('aggregate', 'MIN_BY', 'Returns x from the row with the smallest y.', s('x, y', 'type of x')),
  f('aggregate', 'STRING_AGG', 'Concatenates the non-NULL values, with an optional delimiter.', s('[DISTINCT] expression, [delimiter] [ORDER BY key] [LIMIT n]', 'STRING or BYTES')),
  f('aggregate', 'SUM', 'Returns the sum of the non-NULL values.', s('[DISTINCT] expression', 'INT64, NUMERIC, BIGNUMERIC or FLOAT64')),
  // Approximate aggregate
  f('approximate', 'APPROX_COUNT_DISTINCT', 'Estimates the number of distinct values.', s('expression', 'INT64')),
  f('approximate', 'APPROX_QUANTILES', 'Estimates the quantile boundaries of the values.', s('[DISTINCT] expression, number [{IGNORE | RESPECT} NULLS]', 'ARRAY')),
  f('approximate', 'APPROX_TOP_COUNT', 'Estimates the most frequent values and their counts.', s('expression, number', 'ARRAY<STRUCT<value, count INT64>>')),
  f('approximate', 'APPROX_TOP_SUM', 'Estimates the values with the largest sums of a weight.', s('expression, weight, number', 'ARRAY<STRUCT<value, sum>>')),
  // Array
  f('array', 'ARRAY', 'Makes an array of the rows a subquery returns.', s('subquery', 'ARRAY')),
  f('array', 'ARRAY_CONCAT', 'Concatenates arrays of the same element type.', s('array_expression, ...', 'ARRAY')),
  f('array', 'ARRAY_FIRST', 'Returns an array\'s first element; an error for an empty array.', s('array_expression', 'type of element')),
  f('array', 'ARRAY_LAST', 'Returns an array\'s last element; an error for an empty array.', s('array_expression', 'type of element')),
  f('array', 'ARRAY_LENGTH', 'Returns the number of elements in an array.', s('array_expression', 'INT64')),
  f('array', 'ARRAY_REVERSE', 'Returns an array\'s elements in reverse order.', s('value', 'ARRAY')),
  f('array', 'ARRAY_SLICE', 'Returns the elements between two offsets, which may count from the end when negative.', s('array_to_slice, start_offset, end_offset', 'ARRAY')),
  f('array', 'ARRAY_TO_STRING', 'Joins an array of STRING or BYTES values with a delimiter.', s('array_expression, delimiter, [null_text]', 'STRING or BYTES')),
  f('array', 'GENERATE_ARRAY', 'Makes an array of numbers from start to end by a step.', s('start_expression, end_expression, [step_expression]', 'ARRAY')),
  f('array', 'GENERATE_DATE_ARRAY', 'Makes an array of dates from start to end by an interval.', s('start_date, end_date, [INTERVAL int64_expr date_part]', 'ARRAY<DATE>')),
  f('array', 'GENERATE_TIMESTAMP_ARRAY', 'Makes an array of timestamps from start to end by an interval.', s('start_timestamp, end_timestamp, INTERVAL step_expression date_part', 'ARRAY<TIMESTAMP>')),
  // Bit
  f('bit', 'BIT_COUNT', 'Counts the bits set in an INT64 or BYTES value.', s('expression', 'INT64')),
  // Conditional expressions
  f('conditional', 'COALESCE', 'Returns the first non-NULL argument.', s('expression, ...', 'supertype of the arguments')),
  f('conditional', 'IF', 'Returns one result when the condition is TRUE and another otherwise.', s('expr, true_result, else_result', 'supertype of the results')),
  f('conditional', 'IFNULL', 'Returns the expression, or the replacement when it is NULL.', s('expr, null_result', 'supertype of the arguments')),
  f('conditional', 'NULLIF', 'Returns NULL when the two arguments are equal, and the first otherwise.', s('expr, expr_to_match', 'supertype of the arguments')),
  f('conditional', 'NULLIFZERO', 'Returns NULL for zero, and the value otherwise.', s('expr', 'type of expr')),
  f('conditional', 'ZEROIFNULL', 'Returns zero for NULL, and the value otherwise.', s('expr', 'type of expr')),
  // Conversion
  f('conversion', 'CAST', 'Converts a value to another type; an error when it cannot.', s('expression AS typename [FORMAT format_string_expression]', 'typename')),
  f('conversion', 'PARSE_BIGNUMERIC', 'Reads a STRING as a BIGNUMERIC.', s('string_expression', 'BIGNUMERIC')),
  f('conversion', 'PARSE_NUMERIC', 'Reads a STRING as a NUMERIC.', s('string_expression', 'NUMERIC')),
  f('conversion', 'SAFE_CAST', 'Converts a value to another type, or returns NULL when it cannot.', s('expression AS typename [FORMAT format_string_expression]', 'typename')),
  // Date
  f('date', 'CURRENT_DATE', 'Returns today\'s date, in the default or the given time zone.', s('[time_zone_expression]', 'DATE')),
  f('date', 'DATE', 'Makes a DATE from its parts, or from a TIMESTAMP or DATETIME.', s('year, month, day', 'DATE'), s('timestamp_expression, [time_zone_expression]', 'DATE'), s('datetime_expression', 'DATE')),
  f('date', 'DATE_ADD', 'Adds an interval to a DATE.', s('date_expression, INTERVAL int64_expression date_part', 'DATE')),
  f('date', 'DATE_BUCKET', 'Returns the start of the bucket of a given width that holds a date.', s('date_in_bucket, bucket_width, [bucket_origin_date]', 'DATE')),
  f('date', 'DATE_DIFF', 'Counts the whole date parts between two dates.', s('end_date, start_date, granularity', 'INT64')),
  f('date', 'DATE_FROM_UNIX_DATE', 'Makes a DATE from a number of days since 1970-01-01.', s('int64_expression', 'DATE')),
  f('date', 'DATE_SUB', 'Subtracts an interval from a DATE.', s('date_expression, INTERVAL int64_expression date_part', 'DATE')),
  f('date', 'DATE_TRUNC', 'Truncates a DATE to a granularity.', s('date_value, date_granularity', 'DATE')),
  f('date', 'EXTRACT', 'Returns one part of a date, time, timestamp or interval.', s('part FROM expression [AT TIME ZONE time_zone]', 'INT64, DATE or TIME')),
  f('date', 'FORMAT_DATE', 'Formats a DATE with a format string.', s('format_string, date_expr', 'STRING')),
  f('date', 'LAST_DAY', 'Returns the last day of the date part that holds a date.', s('date_expression, [date_part]', 'DATE')),
  f('date', 'PARSE_DATE', 'Reads a STRING as a DATE with a format string.', s('format_string, date_string', 'DATE')),
  f('date', 'UNIX_DATE', 'Returns the number of days since 1970-01-01.', s('date_expression', 'INT64')),
  // Datetime
  f('datetime', 'CURRENT_DATETIME', 'Returns the current date and time, in the default or the given time zone.', s('[time_zone_expression]', 'DATETIME')),
  f('datetime', 'DATETIME', 'Makes a DATETIME from its parts, a DATE and a TIME, or a TIMESTAMP.', s('year, month, day, hour, minute, second', 'DATETIME'), s('date_expression, [time_expression]', 'DATETIME'), s('timestamp_expression, [time_zone]', 'DATETIME')),
  f('datetime', 'DATETIME_ADD', 'Adds an interval to a DATETIME.', s('datetime_expression, INTERVAL int64_expression part', 'DATETIME')),
  f('datetime', 'DATETIME_BUCKET', 'Returns the start of the bucket of a given width that holds a datetime.', s('datetime_in_bucket, bucket_width, [bucket_origin_datetime]', 'DATETIME')),
  f('datetime', 'DATETIME_DIFF', 'Counts the whole parts between two DATETIME values.', s('end_datetime, start_datetime, granularity', 'INT64')),
  f('datetime', 'DATETIME_SUB', 'Subtracts an interval from a DATETIME.', s('datetime_expression, INTERVAL int64_expression part', 'DATETIME')),
  f('datetime', 'DATETIME_TRUNC', 'Truncates a DATETIME to a granularity.', s('datetime_value, datetime_granularity', 'DATETIME')),
  f('datetime', 'FORMAT_DATETIME', 'Formats a DATETIME with a format string.', s('format_string, datetime_expr', 'STRING')),
  f('datetime', 'PARSE_DATETIME', 'Reads a STRING as a DATETIME with a format string.', s('format_string, datetime_string', 'DATETIME')),
  // Time
  f('time', 'CURRENT_TIME', 'Returns the current time, in the default or the given time zone.', s('[time_zone]', 'TIME')),
  f('time', 'FORMAT_TIME', 'Formats a TIME with a format string.', s('format_string, time_expr', 'STRING')),
  f('time', 'PARSE_TIME', 'Reads a STRING as a TIME with a format string.', s('format_string, time_string', 'TIME')),
  f('time', 'TIME', 'Makes a TIME from its parts, a TIMESTAMP or a DATETIME.', s('hour, minute, second', 'TIME'), s('timestamp, [time_zone]', 'TIME'), s('datetime', 'TIME')),
  f('time', 'TIME_ADD', 'Adds an interval to a TIME.', s('time_expression, INTERVAL int64_expression part', 'TIME')),
  f('time', 'TIME_DIFF', 'Counts the whole parts between two TIME values.', s('end_time, start_time, granularity', 'INT64')),
  f('time', 'TIME_SUB', 'Subtracts an interval from a TIME.', s('time_expression, INTERVAL int64_expression part', 'TIME')),
  f('time', 'TIME_TRUNC', 'Truncates a TIME to a granularity.', s('time_value, time_granularity', 'TIME')),
  // Timestamp
  f('timestamp', 'CURRENT_TIMESTAMP', 'Returns the current time as a TIMESTAMP.', s('', 'TIMESTAMP')),
  f('timestamp', 'FORMAT_TIMESTAMP', 'Formats a TIMESTAMP with a format string, in an optional time zone.', s('format_string, timestamp_expr, [time_zone]', 'STRING')),
  f('timestamp', 'PARSE_TIMESTAMP', 'Reads a STRING as a TIMESTAMP with a format string.', s('format_string, timestamp_string, [time_zone]', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP', 'Makes a TIMESTAMP from a STRING, DATE or DATETIME, in an optional time zone.', s('string_expression, [time_zone]', 'TIMESTAMP'), s('date_expression, [time_zone]', 'TIMESTAMP'), s('datetime_expression, [time_zone]', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_ADD', 'Adds an interval to a TIMESTAMP.', s('timestamp_expression, INTERVAL int64_expression date_part', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_BUCKET', 'Returns the start of the bucket of a given width that holds a timestamp.', s('timestamp_in_bucket, bucket_width, [bucket_origin_timestamp]', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_DIFF', 'Counts the whole parts between two TIMESTAMP values.', s('end_timestamp, start_timestamp, granularity', 'INT64')),
  f('timestamp', 'TIMESTAMP_MICROS', 'Makes a TIMESTAMP from microseconds since 1970-01-01 00:00:00 UTC.', s('int64_expression', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_MILLIS', 'Makes a TIMESTAMP from milliseconds since 1970-01-01 00:00:00 UTC.', s('int64_expression', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_SECONDS', 'Makes a TIMESTAMP from seconds since 1970-01-01 00:00:00 UTC.', s('int64_expression', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_SUB', 'Subtracts an interval from a TIMESTAMP.', s('timestamp_expression, INTERVAL int64_expression date_part', 'TIMESTAMP')),
  f('timestamp', 'TIMESTAMP_TRUNC', 'Truncates a TIMESTAMP to a granularity, in an optional time zone.', s('timestamp_value, timestamp_granularity, [time_zone]', 'TIMESTAMP')),
  f('timestamp', 'UNIX_MICROS', 'Returns microseconds since 1970-01-01 00:00:00 UTC.', s('timestamp_expression', 'INT64')),
  f('timestamp', 'UNIX_MILLIS', 'Returns milliseconds since 1970-01-01 00:00:00 UTC.', s('timestamp_expression', 'INT64')),
  f('timestamp', 'UNIX_SECONDS', 'Returns seconds since 1970-01-01 00:00:00 UTC.', s('timestamp_expression', 'INT64')),
  // Interval
  f('interval', 'JUSTIFY_DAYS', 'Moves whole 30-day periods of an interval into months.', s('interval_expression', 'INTERVAL')),
  f('interval', 'JUSTIFY_HOURS', 'Moves whole 24-hour periods of an interval into days.', s('interval_expression', 'INTERVAL')),
  f('interval', 'JUSTIFY_INTERVAL', 'Applies JUSTIFY_HOURS and then JUSTIFY_DAYS.', s('interval_expression', 'INTERVAL')),
  f('interval', 'MAKE_INTERVAL', 'Makes an INTERVAL from its parts.', s('[year], [month], [day], [hour], [minute], [second]', 'INTERVAL')),
  // Debugging
  f('debugging', 'ERROR', 'Stops the query with the given error message.', s('error_message', 'none')),
  // AEAD encryption
  f('encryption', 'AEAD.DECRYPT_BYTES', 'Decrypts ciphertext with a keyset and the additional data it was encrypted with.', s('keyset, ciphertext, additional_data', 'BYTES')),
  f('encryption', 'AEAD.DECRYPT_STRING', 'Decrypts ciphertext to a STRING with a keyset and its additional data.', s('keyset, ciphertext, additional_data', 'STRING')),
  f('encryption', 'AEAD.ENCRYPT', 'Encrypts plaintext with the keyset\'s primary key and additional data.', s('keyset, plaintext, additional_data', 'BYTES')),
  f('encryption', 'DETERMINISTIC_DECRYPT_BYTES', 'Decrypts deterministically encrypted ciphertext.', s('keyset, ciphertext, additional_data', 'BYTES')),
  f('encryption', 'DETERMINISTIC_DECRYPT_STRING', 'Decrypts deterministically encrypted ciphertext to a STRING.', s('keyset, ciphertext, additional_data', 'STRING')),
  f('encryption', 'DETERMINISTIC_ENCRYPT', 'Encrypts plaintext so that equal inputs give equal ciphertext.', s('keyset, plaintext, additional_data', 'BYTES')),
  f('encryption', 'KEYS.KEYSET_FROM_JSON', 'Reads a keyset from its JSON form.', s('json_keyset', 'BYTES')),
  f('encryption', 'KEYS.KEYSET_LENGTH', 'Returns the number of keys in a keyset.', s('keyset', 'INT64')),
  f('encryption', 'KEYS.KEYSET_TO_JSON', 'Writes a keyset as JSON.', s('keyset', 'STRING')),
  f('encryption', 'KEYS.NEW_KEYSET', 'Makes a keyset with one new key of the given type.', s('key_type', 'BYTES')),
  f('encryption', 'KEYS.ROTATE_KEYSET', 'Adds a new primary key of the given type to a keyset.', s('keyset, key_type', 'BYTES')),
  // Geography
  f('geography', 'ST_AREA', 'Returns the area of a geography\'s polygons, in square meters.', s('geography_expression, [use_spheroid]', 'FLOAT64')),
  f('geography', 'ST_ASBINARY', 'Returns a geography as WKB.', s('geography_expression', 'BYTES')),
  f('geography', 'ST_ASGEOJSON', 'Returns a geography as GeoJSON.', s('geography_expression', 'STRING')),
  f('geography', 'ST_ASTEXT', 'Returns a geography as WKT.', s('geography_expression', 'STRING')),
  f('geography', 'ST_AZIMUTH', 'Returns the azimuth from one point to another, in radians.', s('point_geography_1, point_geography_2', 'FLOAT64')),
  f('geography', 'ST_BOUNDARY', 'Returns the boundary of a geography.', s('geography_expression', 'GEOGRAPHY')),
  f('geography', 'ST_BUFFER', 'Returns the area within a distance of a geography.', s('geography, buffer_radius, [num_seg_quarter_circle => int], [use_spheroid => bool], [endcap => string], [side => string]', 'GEOGRAPHY')),
  f('geography', 'ST_CENTROID', 'Returns the centroid of a geography.', s('geography_expression', 'GEOGRAPHY')),
  f('geography', 'ST_CLOSESTPOINT', 'Returns the point of the first geography closest to the second.', s('geography_1, geography_2, [use_spheroid]', 'GEOGRAPHY')),
  f('geography', 'ST_CLUSTERDBSCAN', 'Assigns geographies to clusters with DBSCAN (an analytic function).', s('geography_column, epsilon, minimum_geographies', 'INT64')),
  f('geography', 'ST_CONTAINS', 'Tells whether the first geography contains the second.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_CONVEXHULL', 'Returns the convex hull of a geography.', s('geography_expression', 'GEOGRAPHY')),
  f('geography', 'ST_COVEREDBY', 'Tells whether the first geography is covered by the second.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_COVERS', 'Tells whether the first geography covers the second.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_DIFFERENCE', 'Returns the part of the first geography outside the second.', s('geography_1, geography_2', 'GEOGRAPHY')),
  f('geography', 'ST_DIMENSION', 'Returns the dimension of a geography\'s highest-dimension part.', s('geography_expression', 'INT64')),
  f('geography', 'ST_DISJOINT', 'Tells whether two geographies have no point in common.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_DISTANCE', 'Returns the shortest distance between two geographies, in meters.', s('geography_1, geography_2, [use_spheroid]', 'FLOAT64')),
  f('geography', 'ST_DWITHIN', 'Tells whether two geographies are within a distance of each other.', s('geography_1, geography_2, distance, [use_spheroid]', 'BOOL')),
  f('geography', 'ST_EQUALS', 'Tells whether two geographies are the same point set.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_EXTENT', 'Returns the bounding box of the geographies of a group (an aggregate).', s('geography_expression', 'STRUCT<xmin FLOAT64, ymin FLOAT64, xmax FLOAT64, ymax FLOAT64>')),
  f('geography', 'ST_GEOGFROM', 'Reads a geography from WKT, WKB or GeoJSON.', s('expression', 'GEOGRAPHY')),
  f('geography', 'ST_GEOGFROMGEOJSON', 'Reads a geography from GeoJSON.', s('geojson_string, [make_valid => constant_expression]', 'GEOGRAPHY')),
  f('geography', 'ST_GEOGFROMTEXT', 'Reads a geography from WKT.', s('wkt_string, [oriented => boolean_constant], [planar => boolean_constant], [make_valid => boolean_constant]', 'GEOGRAPHY')),
  f('geography', 'ST_GEOGFROMWKB', 'Reads a geography from WKB.', s('wkb_bytes_expression, [oriented => boolean_constant], [planar => boolean_constant], [make_valid => boolean_constant]', 'GEOGRAPHY')),
  f('geography', 'ST_GEOGPOINT', 'Makes a point from a longitude and a latitude.', s('longitude, latitude', 'GEOGRAPHY')),
  f('geography', 'ST_GEOGPOINTFROMGEOHASH', 'Returns the center of a GeoHash box.', s('geohash', 'GEOGRAPHY')),
  f('geography', 'ST_GEOHASH', 'Returns the GeoHash of a point.', s('geography_expression, [maxchars]', 'STRING')),
  f('geography', 'ST_INTERSECTION', 'Returns the points two geographies share.', s('geography_1, geography_2', 'GEOGRAPHY')),
  f('geography', 'ST_INTERSECTS', 'Tells whether two geographies share a point.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_ISCOLLECTION', 'Tells whether a geography has more than one part.', s('geography_expression', 'BOOL')),
  f('geography', 'ST_ISEMPTY', 'Tells whether a geography is empty.', s('geography_expression', 'BOOL')),
  f('geography', 'ST_LENGTH', 'Returns the total length of a geography\'s lines, in meters.', s('geography_expression, [use_spheroid]', 'FLOAT64')),
  f('geography', 'ST_MAKELINE', 'Makes a line from points or lines.', s('geography_1, geography_2', 'GEOGRAPHY'), s('array_of_geography', 'GEOGRAPHY')),
  f('geography', 'ST_MAKEPOLYGON', 'Makes a polygon from a shell and optional holes.', s('polygon_shell, [array_of_polygon_holes]', 'GEOGRAPHY')),
  f('geography', 'ST_MAXDISTANCE', 'Returns the longest distance between two geographies, in meters.', s('geography_1, geography_2, [use_spheroid]', 'FLOAT64')),
  f('geography', 'ST_NPOINTS', 'Returns the number of vertices of a geography.', s('geography_expression', 'INT64')),
  f('geography', 'ST_NUMPOINTS', 'Returns the number of vertices of a geography.', s('geography_expression', 'INT64')),
  f('geography', 'ST_PERIMETER', 'Returns the length of a geography\'s polygon boundaries, in meters.', s('geography_expression, [use_spheroid]', 'FLOAT64')),
  f('geography', 'ST_SIMPLIFY', 'Simplifies a geography within a tolerance in meters.', s('geography, tolerance_meters', 'GEOGRAPHY')),
  f('geography', 'ST_SNAPTOGRID', 'Snaps a geography\'s vertices to a grid of degrees.', s('geography_expression, grid_size', 'GEOGRAPHY')),
  f('geography', 'ST_TOUCHES', 'Tells whether two geographies meet only at their boundaries.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_UNION', 'Returns the union of geographies.', s('geography_1, geography_2', 'GEOGRAPHY'), s('array_of_geography', 'GEOGRAPHY')),
  f('geography', 'ST_UNION_AGG', 'Returns the union of the geographies of a group (an aggregate).', s('geography', 'GEOGRAPHY')),
  f('geography', 'ST_WITHIN', 'Tells whether the first geography is within the second.', s('geography_1, geography_2', 'BOOL')),
  f('geography', 'ST_X', 'Returns a point\'s longitude.', s('point_geography_expression', 'FLOAT64')),
  f('geography', 'ST_Y', 'Returns a point\'s latitude.', s('point_geography_expression', 'FLOAT64')),
  // Hash
  f('hash', 'FARM_FINGERPRINT', 'Returns the FarmHash fingerprint of a value.', s('value', 'INT64')),
  f('hash', 'MD5', 'Returns the MD5 hash of a value.', s('input', 'BYTES')),
  f('hash', 'SHA1', 'Returns the SHA-1 hash of a value.', s('input', 'BYTES')),
  f('hash', 'SHA256', 'Returns the SHA-256 hash of a value.', s('input', 'BYTES')),
  f('hash', 'SHA512', 'Returns the SHA-512 hash of a value.', s('input', 'BYTES')),
  // HyperLogLog++
  f('hll', 'HLL_COUNT.EXTRACT', 'Returns the cardinality estimate of a sketch.', s('sketch', 'INT64')),
  f('hll', 'HLL_COUNT.INIT', 'Builds a sketch of the distinct values of a group (an aggregate).', s('input, [precision]', 'BYTES')),
  f('hll', 'HLL_COUNT.MERGE', 'Merges the sketches of a group and returns their cardinality (an aggregate).', s('sketch', 'INT64')),
  f('hll', 'HLL_COUNT.MERGE_PARTIAL', 'Merges the sketches of a group into one sketch (an aggregate).', s('sketch', 'BYTES')),
  // JSON
  f('json', 'BOOL', 'Converts a JSON boolean to BOOL.', s('json_expr', 'BOOL')),
  f('json', 'FLOAT64', 'Converts a JSON number to FLOAT64.', s('json_expr, [wide_number_mode => {\'exact\' | \'round\'}]', 'FLOAT64')),
  f('json', 'INT64', 'Converts a JSON number to INT64.', s('json_expr', 'INT64')),
  f('json', 'JSON_ARRAY', 'Makes a JSON array of the values.', s('[value], ...', 'JSON')),
  f('json', 'JSON_ARRAY_APPEND', 'Appends values to JSON arrays at paths.', s('json_expr, json_path, value, ...', 'JSON')),
  f('json', 'JSON_ARRAY_INSERT', 'Inserts values into JSON arrays at paths.', s('json_expr, json_path, value, ...', 'JSON')),
  f('json', 'JSON_EXTRACT', 'Returns the JSON at a path (the legacy form of JSON_QUERY).', s('json_string_expr, json_path', 'STRING or JSON')),
  f('json', 'JSON_EXTRACT_ARRAY', 'Returns the JSON array at a path as an array (legacy).', s('json_string_expr, [json_path]', 'ARRAY')),
  f('json', 'JSON_EXTRACT_SCALAR', 'Returns the scalar at a path as a STRING (the legacy form of JSON_VALUE).', s('json_string_expr, [json_path]', 'STRING')),
  f('json', 'JSON_EXTRACT_STRING_ARRAY', 'Returns the array of scalars at a path as ARRAY<STRING> (legacy).', s('json_string_expr, [json_path]', 'ARRAY<STRING>')),
  f('json', 'JSON_KEYS', 'Returns the keys of a JSON object, to an optional depth.', s('json_expr, [max_depth], [mode => {\'strict\' | \'lax\' | \'lax recursive\'}]', 'ARRAY<STRING>')),
  f('json', 'JSON_OBJECT', 'Makes a JSON object from keys and values.', s('[json_key, json_value], ...', 'JSON'), s('json_key_array, json_value_array', 'JSON')),
  f('json', 'JSON_QUERY', 'Returns the JSON at a path.', s('json_string_expr, json_path', 'STRING or JSON')),
  f('json', 'JSON_QUERY_ARRAY', 'Returns the JSON array at a path as an array.', s('json_string_expr, [json_path]', 'ARRAY')),
  f('json', 'JSON_REMOVE', 'Removes the JSON at paths.', s('json_expr, json_path, ...', 'JSON')),
  f('json', 'JSON_SET', 'Sets the JSON at paths to values.', s('json_expr, json_path, value, ...', 'JSON')),
  f('json', 'JSON_STRIP_NULLS', 'Removes JSON nulls, and optionally empty objects and arrays.', s('json_expr, [json_path], [include_arrays => bool], [remove_empty => bool]', 'JSON')),
  f('json', 'JSON_TYPE', 'Returns the type of a JSON value (object, array, string, number, boolean or null).', s('json_expr', 'STRING')),
  f('json', 'JSON_VALUE', 'Returns the scalar at a path as a STRING.', s('json_string_expr, [json_path]', 'STRING')),
  f('json', 'JSON_VALUE_ARRAY', 'Returns the array of scalars at a path as ARRAY<STRING>.', s('json_string_expr, [json_path]', 'ARRAY<STRING>')),
  f('json', 'LAX_BOOL', 'Converts a JSON value to BOOL where it can, or returns NULL.', s('json_expr', 'BOOL')),
  f('json', 'LAX_FLOAT64', 'Converts a JSON value to FLOAT64 where it can, or returns NULL.', s('json_expr', 'FLOAT64')),
  f('json', 'LAX_INT64', 'Converts a JSON value to INT64 where it can, or returns NULL.', s('json_expr', 'INT64')),
  f('json', 'LAX_STRING', 'Converts a JSON value to STRING where it can, or returns NULL.', s('json_expr', 'STRING')),
  f('json', 'PARSE_JSON', 'Reads a STRING as JSON.', s('json_string_expr, [wide_number_mode => {\'exact\' | \'round\'}]', 'JSON')),
  f('json', 'STRING', 'Converts a JSON string to STRING.', s('json_expr', 'STRING')),
  f('json', 'TO_JSON', 'Converts a value to JSON.', s('sql_value, [stringify_wide_numbers => bool]', 'JSON')),
  f('json', 'TO_JSON_STRING', 'Converts a value to JSON text, optionally pretty-printed.', s('value, [pretty_print]', 'STRING')),
  // Mathematical
  f('math', 'ABS', 'Returns the absolute value.', s('X', 'type of X')),
  f('math', 'ACOS', 'Returns the inverse cosine, in radians.', s('X', 'FLOAT64')),
  f('math', 'ACOSH', 'Returns the inverse hyperbolic cosine.', s('X', 'FLOAT64')),
  f('math', 'ASIN', 'Returns the inverse sine, in radians.', s('X', 'FLOAT64')),
  f('math', 'ASINH', 'Returns the inverse hyperbolic sine.', s('X', 'FLOAT64')),
  f('math', 'ATAN', 'Returns the inverse tangent, in radians.', s('X', 'FLOAT64')),
  f('math', 'ATAN2', 'Returns the angle of the point (Y, X), in radians.', s('X, Y', 'FLOAT64')),
  f('math', 'ATANH', 'Returns the inverse hyperbolic tangent.', s('X', 'FLOAT64')),
  f('math', 'CBRT', 'Returns the cube root.', s('X', 'FLOAT64')),
  f('math', 'CEIL', 'Returns the smallest integral value not less than X.', s('X', 'type of X')),
  f('math', 'CEILING', 'Returns the smallest integral value not less than X (a synonym of CEIL).', s('X', 'type of X')),
  f('math', 'COS', 'Returns the cosine of an angle in radians.', s('X', 'FLOAT64')),
  f('math', 'COSH', 'Returns the hyperbolic cosine.', s('X', 'FLOAT64')),
  f('math', 'COSINE_DISTANCE', 'Returns the cosine distance between two vectors.', s('vector1, vector2', 'FLOAT64')),
  f('math', 'COT', 'Returns the cotangent of an angle in radians.', s('X', 'FLOAT64')),
  f('math', 'COTH', 'Returns the hyperbolic cotangent.', s('X', 'FLOAT64')),
  f('math', 'CSC', 'Returns the cosecant of an angle in radians.', s('X', 'FLOAT64')),
  f('math', 'CSCH', 'Returns the hyperbolic cosecant.', s('X', 'FLOAT64')),
  f('math', 'DIV', 'Divides X by Y, rounding toward zero.', s('X, Y', 'INT64, NUMERIC or BIGNUMERIC')),
  f('math', 'EUCLIDEAN_DISTANCE', 'Returns the Euclidean distance between two vectors.', s('vector1, vector2', 'FLOAT64')),
  f('math', 'EXP', 'Returns e raised to the power X.', s('X', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'FLOOR', 'Returns the largest integral value not greater than X.', s('X', 'type of X')),
  f('math', 'GREATEST', 'Returns the largest argument, or NULL when any is NULL.', s('X1, ...', 'supertype of the arguments')),
  f('math', 'IEEE_DIVIDE', 'Divides X by Y as IEEE 754 does: dividing by zero gives an infinity or NaN.', s('X, Y', 'FLOAT64')),
  f('math', 'IS_INF', 'Tells whether X is an infinity.', s('X', 'BOOL')),
  f('math', 'IS_NAN', 'Tells whether X is NaN.', s('X', 'BOOL')),
  f('math', 'LEAST', 'Returns the smallest argument, or NULL when any is NULL.', s('X1, ...', 'supertype of the arguments')),
  f('math', 'LN', 'Returns the natural logarithm.', s('X', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'LOG', 'Returns the logarithm of X, natural or to base Y.', s('X, [Y]', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'LOG10', 'Returns the base-10 logarithm.', s('X', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'MOD', 'Returns the remainder of X divided by Y.', s('X, Y', 'INT64, NUMERIC or BIGNUMERIC')),
  f('math', 'POW', 'Returns X raised to the power Y.', s('X, Y', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'POWER', 'Returns X raised to the power Y (a synonym of POW).', s('X, Y', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'RAND', 'Returns a pseudo-random FLOAT64 in [0, 1).', s('', 'FLOAT64')),
  f('math', 'RANGE_BUCKET', 'Returns the position of a point in an array of sorted boundaries.', s('point, boundaries_array', 'INT64')),
  f('math', 'ROUND', 'Rounds X to N decimal places, with an optional rounding mode.', s('X, [N], [rounding_mode]', 'type of X')),
  f('math', 'SAFE_ADD', 'Adds X and Y, or returns NULL on overflow.', s('X, Y', 'supertype of the arguments')),
  f('math', 'SAFE_DIVIDE', 'Divides X by Y, or returns NULL when Y is zero or on overflow.', s('X, Y', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'SAFE_MULTIPLY', 'Multiplies X and Y, or returns NULL on overflow.', s('X, Y', 'supertype of the arguments')),
  f('math', 'SAFE_NEGATE', 'Negates X, or returns NULL on overflow.', s('X', 'type of X')),
  f('math', 'SAFE_SUBTRACT', 'Subtracts Y from X, or returns NULL on overflow.', s('X, Y', 'supertype of the arguments')),
  f('math', 'SEC', 'Returns the secant of an angle in radians.', s('X', 'FLOAT64')),
  f('math', 'SECH', 'Returns the hyperbolic secant.', s('X', 'FLOAT64')),
  f('math', 'SIGN', 'Returns -1, 0 or +1 for the sign of X.', s('X', 'type of X')),
  f('math', 'SIN', 'Returns the sine of an angle in radians.', s('X', 'FLOAT64')),
  f('math', 'SINH', 'Returns the hyperbolic sine.', s('X', 'FLOAT64')),
  f('math', 'SQRT', 'Returns the square root.', s('X', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('math', 'TAN', 'Returns the tangent of an angle in radians.', s('X', 'FLOAT64')),
  f('math', 'TANH', 'Returns the hyperbolic tangent.', s('X', 'FLOAT64')),
  f('math', 'TRUNC', 'Truncates X toward zero, to N decimal places.', s('X, [N]', 'type of X')),
  // Navigation
  f('navigation', 'FIRST_VALUE', 'Returns the value at the first row of the window frame.', s('value_expression [{RESPECT | IGNORE} NULLS]', 'type of value_expression')),
  f('navigation', 'LAG', 'Returns the value at a row a given number of rows before the current one.', s('value_expression, [offset], [default_expression]', 'type of value_expression')),
  f('navigation', 'LAST_VALUE', 'Returns the value at the last row of the window frame.', s('value_expression [{RESPECT | IGNORE} NULLS]', 'type of value_expression')),
  f('navigation', 'LEAD', 'Returns the value at a row a given number of rows after the current one.', s('value_expression, [offset], [default_expression]', 'type of value_expression')),
  f('navigation', 'NTH_VALUE', 'Returns the value at the Nth row of the window frame.', s('value_expression, constant_integer_expression [{RESPECT | IGNORE} NULLS]', 'type of value_expression')),
  f('navigation', 'PERCENTILE_CONT', 'Returns an interpolated percentile of the values.', s('value_expression, percentile [{RESPECT | IGNORE} NULLS]', 'FLOAT64, NUMERIC or BIGNUMERIC')),
  f('navigation', 'PERCENTILE_DISC', 'Returns the first value at or above a percentile of the values.', s('value_expression, percentile [{RESPECT | IGNORE} NULLS]', 'type of value_expression')),
  // Net
  f('net', 'NET.HOST', 'Returns the host of a URL.', s('url', 'STRING')),
  f('net', 'NET.IP_FROM_STRING', 'Reads an IPv4 or IPv6 address as BYTES; an error when it is invalid.', s('addr_str', 'BYTES')),
  f('net', 'NET.IP_NET_MASK', 'Returns a network mask of a length and prefix.', s('num_output_bytes, prefix_length', 'BYTES')),
  f('net', 'NET.IP_TO_STRING', 'Writes an address in BYTES as text.', s('addr_bin', 'STRING')),
  f('net', 'NET.IP_TRUNC', 'Keeps the first prefix_length bits of an address.', s('addr_bin, prefix_length', 'BYTES')),
  f('net', 'NET.IPV4_FROM_INT64', 'Makes an IPv4 address from an integer.', s('integer_value', 'BYTES')),
  f('net', 'NET.IPV4_TO_INT64', 'Returns an IPv4 address as an integer.', s('addr_bin', 'INT64')),
  f('net', 'NET.PUBLIC_SUFFIX', 'Returns the public suffix of a URL\'s host (such as com or co.uk).', s('url', 'STRING')),
  f('net', 'NET.REG_DOMAIN', 'Returns the registered domain of a URL\'s host.', s('url', 'STRING')),
  f('net', 'NET.SAFE_IP_FROM_STRING', 'Reads an IPv4 or IPv6 address as BYTES, or returns NULL when it is invalid.', s('addr_str', 'BYTES')),
  // Numbering
  f('numbering', 'CUME_DIST', 'Returns the relative rank of the row, in (0, 1].', s('', 'FLOAT64')),
  f('numbering', 'DENSE_RANK', 'Returns the row\'s rank, with no gaps after ties.', s('', 'INT64')),
  f('numbering', 'NTILE', 'Divides the rows into a number of buckets and returns the row\'s bucket.', s('constant_integer_expression', 'INT64')),
  f('numbering', 'PERCENT_RANK', 'Returns the row\'s percentile rank, in [0, 1].', s('', 'FLOAT64')),
  f('numbering', 'RANK', 'Returns the row\'s rank, with gaps after ties.', s('', 'INT64')),
  f('numbering', 'ROW_NUMBER', 'Numbers the rows of the window from 1.', s('', 'INT64')),
  // Range
  f('range', 'GENERATE_RANGE_ARRAY', 'Splits a range into an array of ranges of a step.', s('range_to_split, step_interval, [include_last_partial_range]', 'ARRAY<RANGE>')),
  f('range', 'RANGE', 'Makes a range from a lower and an upper bound.', s('lower_bound, upper_bound', 'RANGE')),
  f('range', 'RANGE_CONTAINS', 'Tells whether a range contains a value or another range.', s('outer_range, inner_range', 'BOOL'), s('range_to_search, value_to_find', 'BOOL')),
  f('range', 'RANGE_END', 'Returns a range\'s upper bound.', s('range_to_check', 'type of the bound')),
  f('range', 'RANGE_INTERSECT', 'Returns the range two ranges share.', s('range_a, range_b', 'RANGE')),
  f('range', 'RANGE_OVERLAPS', 'Tells whether two ranges overlap.', s('range_a, range_b', 'BOOL')),
  f('range', 'RANGE_SESSIONIZE', 'Merges overlapping or adjacent ranges of a table (a table function).', s('TABLE table_name, range_column, partitioning_columns, [sessionize_option]', 'TABLE')),
  f('range', 'RANGE_START', 'Returns a range\'s lower bound.', s('range_to_check', 'type of the bound')),
  // Search
  f('search', 'SEARCH', 'Tells whether text in the data matches every term of a search query.', s('search_data, search_query, [json_scope => json_scope_value], [analyzer => analyzer_name], [analyzer_options => analyzer_options_values]', 'BOOL')),
  // Security
  f('security', 'SESSION_USER', 'Returns the email address of the user running the query.', s('', 'STRING')),
  // Statistical aggregate
  f('statistical', 'CORR', 'Returns the Pearson correlation coefficient of number pairs.', s('X1, X2', 'FLOAT64')),
  f('statistical', 'COVAR_POP', 'Returns the population covariance of number pairs.', s('X1, X2', 'FLOAT64')),
  f('statistical', 'COVAR_SAMP', 'Returns the sample covariance of number pairs.', s('X1, X2', 'FLOAT64')),
  f('statistical', 'STDDEV', 'Returns the sample standard deviation (a synonym of STDDEV_SAMP).', s('[DISTINCT] expression', 'FLOAT64')),
  f('statistical', 'STDDEV_POP', 'Returns the population standard deviation.', s('[DISTINCT] expression', 'FLOAT64')),
  f('statistical', 'STDDEV_SAMP', 'Returns the sample standard deviation.', s('[DISTINCT] expression', 'FLOAT64')),
  f('statistical', 'VAR_POP', 'Returns the population variance.', s('[DISTINCT] expression', 'FLOAT64')),
  f('statistical', 'VAR_SAMP', 'Returns the sample variance.', s('[DISTINCT] expression', 'FLOAT64')),
  f('statistical', 'VARIANCE', 'Returns the sample variance (a synonym of VAR_SAMP).', s('[DISTINCT] expression', 'FLOAT64')),
  // String
  f('string', 'ASCII', 'Returns the code of the first character or byte.', s('value', 'INT64')),
  f('string', 'BYTE_LENGTH', 'Returns the length in bytes.', s('value', 'INT64')),
  f('string', 'CHAR_LENGTH', 'Returns the length of a STRING in characters.', s('value', 'INT64')),
  f('string', 'CHARACTER_LENGTH', 'Returns the length of a STRING in characters (a synonym of CHAR_LENGTH).', s('value', 'INT64')),
  f('string', 'CHR', 'Returns the character of a Unicode code point.', s('value', 'STRING')),
  f('string', 'CODE_POINTS_TO_BYTES', 'Makes BYTES from an array of extended ASCII code points.', s('ascii_code_points', 'BYTES')),
  f('string', 'CODE_POINTS_TO_STRING', 'Makes a STRING from an array of Unicode code points.', s('unicode_code_points', 'STRING')),
  f('string', 'COLLATE', 'Attaches a collation to a STRING.', s('value, collate_specification', 'STRING')),
  f('string', 'CONCAT', 'Concatenates STRING or BYTES values.', s('value, ...', 'STRING or BYTES')),
  f('string', 'CONTAINS_SUBSTR', 'Tells whether a value, or any field of it, contains the text, ignoring case.', s('expression, search_value_literal, [json_scope => json_scope_value]', 'BOOL')),
  f('string', 'EDIT_DISTANCE', 'Returns the Levenshtein distance between two values.', s('value1, value2, [max_distance => max_distance_value]', 'INT64')),
  f('string', 'ENDS_WITH', 'Tells whether a value ends with a suffix.', s('value, suffix', 'BOOL')),
  f('string', 'FORMAT', 'Formats values with a printf-style format string.', s('format_string_expression, data_type_expression, ...', 'STRING')),
  f('string', 'FROM_BASE32', 'Decodes base32 text to BYTES.', s('string_expr', 'BYTES')),
  f('string', 'FROM_BASE64', 'Decodes base64 text to BYTES.', s('string_expr', 'BYTES')),
  f('string', 'FROM_HEX', 'Decodes hexadecimal text to BYTES.', s('value', 'BYTES')),
  f('string', 'INITCAP', 'Capitalizes the first letter of each word.', s('value, [delimiters]', 'STRING')),
  f('string', 'INSTR', 'Returns the position of an occurrence of a subvalue, from 1, or 0.', s('value, subvalue, [position], [occurrence]', 'INT64')),
  f('string', 'LEFT', 'Returns the first characters or bytes of a value.', s('value, length', 'STRING or BYTES')),
  f('string', 'LENGTH', 'Returns the length in characters (STRING) or bytes (BYTES).', s('value', 'INT64')),
  f('string', 'LOWER', 'Returns a value in lower case.', s('value', 'STRING or BYTES')),
  f('string', 'LPAD', 'Pads a value on the left to a length.', s('original_value, return_length, [pattern]', 'STRING or BYTES')),
  f('string', 'LTRIM', 'Removes leading whitespace or the given characters.', s('value, [set_of_characters_to_remove]', 'STRING or BYTES')),
  f('string', 'NORMALIZE', 'Normalizes a STRING to a Unicode normalization form.', s('value, [normalization_mode]', 'STRING')),
  f('string', 'NORMALIZE_AND_CASEFOLD', 'Normalizes and case-folds a STRING, for comparing without case.', s('value, [normalization_mode]', 'STRING')),
  f('string', 'OCTET_LENGTH', 'Returns the length in bytes (a synonym of BYTE_LENGTH).', s('value', 'INT64')),
  f('string', 'REGEXP_CONTAINS', 'Tells whether a value matches a regular expression anywhere.', s('value, regexp', 'BOOL')),
  f('string', 'REGEXP_EXTRACT', 'Returns the first match of a regular expression, or its capturing group.', s('value, regexp, [position], [occurrence]', 'STRING or BYTES')),
  f('string', 'REGEXP_EXTRACT_ALL', 'Returns every match of a regular expression.', s('value, regexp', 'ARRAY')),
  f('string', 'REGEXP_INSTR', 'Returns the position of a match of a regular expression, from 1, or 0.', s('source_value, regexp, [position], [occurrence], [occurrence_position]', 'INT64')),
  f('string', 'REGEXP_REPLACE', 'Replaces every match of a regular expression.', s('value, regexp, replacement', 'STRING or BYTES')),
  f('string', 'REGEXP_SUBSTR', 'Returns a match of a regular expression (a synonym of REGEXP_EXTRACT).', s('value, regexp, [position], [occurrence]', 'STRING or BYTES')),
  f('string', 'REPEAT', 'Repeats a value a number of times.', s('original_value, repetitions', 'STRING or BYTES')),
  f('string', 'REPLACE', 'Replaces every occurrence of a pattern.', s('original_value, from_pattern, to_pattern', 'STRING or BYTES')),
  f('string', 'REVERSE', 'Returns a value\'s characters or bytes in reverse order.', s('value', 'STRING or BYTES')),
  f('string', 'RIGHT', 'Returns the last characters or bytes of a value.', s('value, length', 'STRING or BYTES')),
  f('string', 'RPAD', 'Pads a value on the right to a length.', s('original_value, return_length, [pattern]', 'STRING or BYTES')),
  f('string', 'RTRIM', 'Removes trailing whitespace or the given characters.', s('value, [set_of_characters_to_remove]', 'STRING or BYTES')),
  f('string', 'SAFE_CONVERT_BYTES_TO_STRING', 'Converts BYTES to a STRING, replacing invalid UTF-8 with U+FFFD.', s('value', 'STRING')),
  f('string', 'SOUNDEX', 'Returns the Soundex code of a STRING.', s('value', 'STRING')),
  f('string', 'SPLIT', 'Splits a value on a delimiter (a comma by default).', s('value, [delimiter]', 'ARRAY')),
  f('string', 'STARTS_WITH', 'Tells whether a value starts with a prefix.', s('value, prefix', 'BOOL')),
  f('string', 'STRPOS', 'Returns the position of the first occurrence of a subvalue, from 1, or 0.', s('value, subvalue', 'INT64')),
  f('string', 'SUBSTR', 'Returns part of a value from a position, of an optional length.', s('value, position, [length]', 'STRING or BYTES')),
  f('string', 'SUBSTRING', 'Returns part of a value (a synonym of SUBSTR).', s('value, position, [length]', 'STRING or BYTES')),
  f('string', 'TO_BASE32', 'Encodes BYTES as base32 text.', s('bytes_expr', 'STRING')),
  f('string', 'TO_BASE64', 'Encodes BYTES as base64 text.', s('bytes_expr', 'STRING')),
  f('string', 'TO_CODE_POINTS', 'Returns the code points of a STRING, or the bytes of BYTES.', s('value', 'ARRAY<INT64>')),
  f('string', 'TO_HEX', 'Encodes BYTES as hexadecimal text.', s('bytes', 'STRING')),
  f('string', 'TRANSLATE', 'Replaces each source character with its target character.', s('expression, source_characters, target_characters', 'STRING or BYTES')),
  f('string', 'TRIM', 'Removes leading and trailing whitespace or the given characters.', s('value, [set_of_characters_to_remove]', 'STRING or BYTES')),
  f('string', 'UNICODE', 'Returns the code point of the first character.', s('value', 'INT64')),
  f('string', 'UPPER', 'Returns a value in upper case.', s('value', 'STRING or BYTES')),
  // Utility
  f('utility', 'GENERATE_UUID', 'Returns a random version 4 UUID as text.', s('', 'STRING'))
]

const byName = new Map(googleSqlFunctions.map(entry => [entry.name, entry]))
/** A function by its name in any case, with its namespace (`net.host`); a `SAFE.` prefix (NULL in place of an error)
 *  finds the function it prefixes. */
export function googleSqlFunction(name: string): GoogleSqlFunction | undefined {
  const upper = name.toUpperCase()
  return byName.get(upper) ?? (upper.startsWith('SAFE.') ? byName.get(upper.slice(5)) : undefined)
}

/** A signature as signature help and the docs show it, and where each parameter sits in that text. */
export function signatureLabel(name: string, signature: GoogleSqlSignature): { label: string; parameters: [number, number][] } {
  let label = `${name}(`
  const parameters: [number, number][] = []
  signature.parameters.forEach((parameter, index) => {
    if (index) label += ', '
    parameters.push([label.length, label.length + parameter.length])
    label += parameter
  })
  return { label: `${label}) → ${signature.returns}`, parameters }
}

/**
 * The parameter an argument fills: its own, or for an argument at or past a `...` the parameter it repeats; undefined
 * when the signature takes fewer arguments.
 */
export function parameterFor(signature: GoogleSqlSignature, argument: number): number | undefined {
  const { parameters } = signature, repeat = parameters.indexOf('...')
  if (repeat < 0) return argument < parameters.length ? argument : undefined
  return argument < repeat ? argument : repeat - 1
}
