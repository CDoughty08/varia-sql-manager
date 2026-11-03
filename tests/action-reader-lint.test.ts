import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Object actions run their statements through a reader (ActionService.ReadAllAsync): SqlClient's async non-query path holds every
// info message until the statement ends, so a RESTORE's STATS progress (message 3211) would reach the page only once it is done.
// No check can see that from a statement that ends at once, so the backend's action code may not call the non-reader paths at
// all, except the session prologue (SET options, which send no messages).
const root = join(__dirname, '..', 'backend', 'Varia.Backend')
const prologue = 'private static async Task RunAsync(SqlConnection connection, string sql, CancellationToken token)'
const forbidden = /\bExecute(NonQuery|Scalar)(Async)?\b/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.cs') ? [join(dir, entry.name)] : [])
}

/** The code without comments, so a comment may still name what it forbids. */
function code(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
}

/** The calls outside the prologue's body, as file:line. */
function nonReaderCalls(file: string, text: string): string[] {
  const body = code(text)
  const start = body.indexOf(prologue)
  const end = start < 0 ? -1 : body.indexOf('\n    }\n', start)
  return [...body.matchAll(forbidden)].filter(match => !(start >= 0 && match.index > start && match.index < end))
    .map(match => `${file}:${body.slice(0, match.index).split('\n').length}`)
}

describe('object action statements', () => {
  const files = [...sources(join(root, 'Actions')), ...sources(join(root, 'Designer')), join(root, 'Activity', 'SessionActions.cs')]

  it('run only through a reader, never ExecuteNonQuery or ExecuteScalar, outside the session prologue', () => {
    expect(files.length).toBeGreaterThan(10)
    expect(code(readFileSync(join(root, 'Actions', 'ActionService.cs'), 'utf8'))).toContain(prologue)
    expect(files.flatMap(file => nonReaderCalls(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')))).toEqual([])
  })

  it('finds a non-reader call anywhere but the prologue, and ignores comments', () => {
    const text = [
      'class A {',
      `    ${prologue}`,
      '    {',
      '        await command.ExecuteNonQueryAsync(token);',
      '    }',
      '    /// <summary>never ExecuteNonQueryAsync</summary>',
      '    async Task RunStatementAsync() { await command.ExecuteNonQueryAsync(token); return []; }',
      '    void B() { _ = command.ExecuteScalar(); }',
      '}'
    ].join('\n')
    expect(nonReaderCalls('A.cs', text)).toEqual(['A.cs:7', 'A.cs:8'])
  })
})
