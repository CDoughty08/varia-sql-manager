// Renders docs/googlesql.md from the GoogleSQL catalogue; tests/googlesql-catalog.test.ts keeps the file in sync.
import {
  googleSqlCategories, googleSqlFunctions, googleSqlKeywords, googleSqlNiladicFunctions, googleSqlReservedKeywords, googleSqlTypes, signatureLabel,
  type GoogleSqlCategory
} from './catalog'

const cell = (value: string) => value.replaceAll('|', '\\|')
const code = (value: string) => '`' + value + '`'
const words = (list: readonly string[]) => [...list].sort().map(code).join(', ')

export function renderGoogleSqlDocs(): string {
  const lines: string[] = [
    '# GoogleSQL editor',
    '',
    '<!-- Generated from src/shared/googlesql/catalog.ts. Regenerate with: npx vitest run tests/googlesql-catalog.test.ts -u -->',
    '',
    'A query on a BigQuery connection is edited as GoogleSQL; a query on SQL Server stays Transact-SQL. Both are the same kind',
    'of tab: only its language, its colours and its signature help differ.',
    '',
    '## Language',
    '',
    '- **Follows the connection.** A query opened on a BigQuery connection is GoogleSQL. Changing a tab\'s connection to',
    '  one of the other engine switches its language and clears its error markers, and a notification says so, since the',
    '  SQL is unlikely to run as is (an empty query switches silently). Disconnecting keeps the language.',
    '- **Caption.** The tab\'s icon is named "GoogleSQL" or "Transact-SQL".',
    '- **Kept.** Hot exit, AutoRecover and Reopen Closed Query keep a query\'s engine, so a BigQuery query reopens as GoogleSQL',
    '  without its connection. Nothing is checked or sent to Google when a tab switches or reopens.',
    '- **Highlighting.** Backtick identifiers with dots and dashes (`` `my-proj.dataset.table` ``), `r`, `b`, `rb` and `br`',
    '  string prefixes, triple-quoted strings, `--`, `#` and `/* */` comments, `@param` and `@@system_variable`,',
    '  `STRUCT<…>`, `ARRAY<…>` and `RANGE<…>` types, and the keywords below. Function names are coloured where they are called,',
    '  since many (`DATE`, `LEFT`, `FORMAT`) are common column names too; a name after a dot is always a name, except a',
    '  namespaced function\'s (`NET.HOST(`, `SAFE.NET.HOST(`). The colours',
    '  are the SQL syntax colours of the theme.',
    '- **Brackets and quotes.** `(` and `[` pair and match; quotes and backticks close themselves outside strings and',
    '  comments (accepting a leaf completion steps past the closing backtick; [language-services.md](language-services.md#completion-from-the-index)). Toggle Comment uses `--`.',
    '- **Signature help.** Typing `(` or `,` in a call to a function below shows its signatures and the parameter the caret',
    '  is in; **Ctrl+Shift+Space** (**⇧⌘Space** on macOS) shows it on demand, and **Up** and **Down** step through a',
    '  function\'s signatures. A `SAFE.` prefix shows the function it prefixes. Nothing shows inside a string or a comment, in',
    '  a parenthesis no function name precedes, or in a document over 250,000 characters.',
    '',
    'Completion and hover come from the connection\'s Search Objects index, with the aliases and `WITH` names in scope',
    '([language-services.md](language-services.md#completion-from-the-index)); a dry run marks errors as you pause typing',
    '([bigquery.md](bigquery.md#cost)).',
    '',
    '## Keywords',
    '',
    `Reserved keywords (${googleSqlReservedKeywords.length}): ${words(googleSqlReservedKeywords)}.`,
    '',
    `Other keywords (${googleSqlKeywords.length}): ${words(googleSqlKeywords)}.`,
    '',
    `Types (${googleSqlTypes.length}): ${words(googleSqlTypes)}.`,
    '',
    `Functions callable without parentheses: ${words(googleSqlNiladicFunctions)}.`,
    '',
    '## Functions',
    '',
    `${googleSqlFunctions.length} functions, from Google's public GoogleSQL reference for BigQuery, with Varia's own one-line`,
    'summaries. An optional parameter is in brackets; `...` repeats the parameter before it.',
    ''
  ]
  for (const category of Object.keys(googleSqlCategories) as GoogleSqlCategory[]) {
    const entries = googleSqlFunctions.filter(entry => entry.category === category)
    lines.push(`### ${googleSqlCategories[category]}`, '', '| Function | Signatures | Summary |', '| --- | --- | --- |')
    for (const entry of entries) {
      const signatures = entry.signatures.map(signature => code(signatureLabel(entry.name, signature).label)).join('<br>')
      lines.push(`| ${code(entry.name)} | ${cell(signatures)} | ${cell(entry.summary)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
