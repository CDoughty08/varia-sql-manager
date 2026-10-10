// Synthetic result shapes for the fake backend's `-- varia-fake:` directive, after the C# SyntheticRows shapes (the
// same columns and kinds of values, not the same bytes). Every cell is a pure function of (shape, row), so any range of
// a million-row result can be produced on demand, and smoke tests can compute what a row holds.
//   W1  a typical wide row: int, nvarchar, datetime2, decimal, uniqueidentifier, nvarchar, bit, int (NULL every 5th)
//   N1  edge cases: NULLs, read errors, truncated cells, empty strings, astral characters, a BOM, TAB/LF/quotes, binary
//   B1  two nvarchar(max) values of about 4 KB
//   X1  300 columns cycling int, nvarchar(30) and datetime2
//   X2  300 bit columns: the narrowest columns, so the most cells in view (fake backend only)
//   L1  well-formed xml, json and plan documents of about 1 KB, 64 KB and 2 MB in turn
//   M1  one int column (M1*n is n one-row sets)

const column = (name, dataType, wire = 'text', role) => ({ name, dataType, wire, ...role ? { role } : {}, nullable: true })
const pad = (value, width) => String(value).padStart(width, '0')
const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '
const epoch = Date.UTC(2026, 0, 1)
const unicode = ['', 'é', '日本語', '😀 astral', '﻿bom', 'tab\tline\nquote"\\']

function datetime2(ms, ticks) {
  const date = new Date(epoch + ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)} ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}.${pad(ticks, 7)}`
}
function decimal(cents, negative) { return (negative ? '-' : '') + Math.floor(cents / 100) + '.' + pad(cents % 100, 2) }
function guid(row) { const hex = pad(row.toString(16).toUpperCase(), 12); return `${pad((row % 0xffffffff).toString(16).toUpperCase(), 8)}-0000-4A1F-9C2E-${hex.slice(-12)}` }

/** Documents of about `size` characters: a head, repeated units and a tail, well formed for the formatters. */
function document(size, head, unit, separator, tail) {
  const parts = [head]
  let length = head.length + tail.length
  for (let i = 1; length + 128 < size; i++) { const piece = (i === 1 ? '' : separator) + unit(i); parts.push(piece); length += piece.length }
  parts.push(tail)
  return parts.join('')
}
const documentSizes = [1024, 65_536, 2_097_152 - 1024]
let documents
function documentsFor(index) {
  documents ??= documentSizes.map(size => [
    document(size, '<root kind="synthetic">', i => `<item id="${i}"><name>Item ${i}</name><note>a &amp; b</note></item>`, '', '</root>'),
    document(size, '{"items":[', i => `{"id":${i},"name":"Item ${i}","price":12.50,"tags":["a","b"]}`, ',', ']}'),
    document(size, '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.6"><BatchSequence><Batch><Statements>',
      i => `<StmtSimple StatementId="${i}" StatementText="SELECT ${i}" StatementType="SELECT" />`, '', '</Statements></Batch></BatchSequence></ShowPlanXML>')
  ])
  return documents[index]
}

export const shapes = {
  W1: {
    columns: [column('id', 'int'), column('name', 'nvarchar(50)'), column('created', 'datetime2(7)'), column('amount', 'decimal(18,2)'), column('key', 'uniqueidentifier'),
      column('note', 'nvarchar(200)'), column('active', 'bit'), column('score', 'int')],
    pageRows: 1024,
    row: r => {
      const note = `Note ${r}: `
      return [String(r), r % 7 === 3 ? `Société ${pad(r, 10)} SARL` : `Customer ${pad(r, 10)} GmbH`, datetime2(r * 1000, r * 1_234_567 % 10_000_000), decimal(r * 7919 % 100_000_000, r % 11 === 5),
        guid(r), note + lorem.slice(0, 80 - note.length), r % 3 === 0 ? '1' : '0', r % 5 === 4 ? null : String(r * 31 % 1000)]
    }
  },
  N1: {
    columns: [column('id', 'int'), column('maybe', 'nvarchar(20)'), column('unicode', 'nvarchar(max)'), column('clipped', 'nvarchar(max)'), column('failed', 'int'),
      column('bytes', 'varbinary(16)', 'binary'), column('none', 'int')],
    pageRows: 1024,
    row: r => [String(r), r % 3 === 1 ? null : 'n' + r, unicode[r % unicode.length], r % 4 === 1 ? { value: 'truncated pre', truncated: true } : 'complete ' + r,
      r % 5 === 2 ? { error: true } : r % 5 === 3 ? null : String(r * 37 % 100),
      r % 4 === 0 ? new Uint8Array(0) : r % 4 === 1 ? null : r % 4 === 2 ? Uint8Array.of(r & 255, 0xff, 0) : { value: Uint8Array.from({ length: 16 }, (_, i) => i), truncated: true }, null]
  },
  B1: {
    columns: [column('first', 'nvarchar(max)'), column('second', 'nvarchar(max)')],
    pageRows: 32,
    row: r => { const filler = lorem.repeat(40).slice(0, 4096); return [pad(r, 10) + filler.slice(10), r.toString(16).toUpperCase().padStart(10, '0') + filler.slice(10, 4089)] }
  },
  X1: {
    columns: Array.from({ length: 300 }, (_, i) => column('c' + pad(i, 3), ['int', 'nvarchar(30)', 'datetime2(7)'][i % 3])),
    pageRows: 64,
    row: r => Array.from({ length: 300 }, (_, c) => c % 3 === 0 ? String(r * 1000 + c) : c % 3 === 1 ? `r${r}c${c}` : datetime2(r * 1000 + c, 0))
  },
  X2: {
    columns: Array.from({ length: 300 }, (_, i) => column('b' + pad(i, 3), 'bit')),
    pageRows: 256,
    row: r => Array.from({ length: 300 }, (_, c) => (r + c) % 3 === 0 ? '1' : '0')
  },
  L1: {
    columns: [column('id', 'int'), column('doc', 'xml', 'text', 'xml'), column('data', 'json', 'text', 'json'), column('plan', 'nvarchar(max)', 'text', 'plan')],
    pageRows: 1,
    row: r => [String(r), ...documentsFor(r % documentSizes.length)]
  },
  M1: { columns: [column('value', 'int')], pageRows: 64, row: r => [String(r)] }
}

/**
 * The directive on a script's first line: `-- varia-fake: sets=W1*200000@50000,N1*100 messages=40 errors=2 memory=0.92 hold`.
 * `@rate` streams that many rows a second; `M1*n` is n one-row sets; `hold` keeps the script running while the control
 * file hold/query.execute exists. Returns undefined when the script has no directive.
 */
export function parseDirective(sql) {
  const match = /^--\s*varia-fake:(.*)$/m.exec(sql.split('\n', 1)[0])
  if (!match) return undefined
  const directive = { sets: [], messages: 0, errors: 0, memory: undefined, hold: false }
  for (const token of match[1].trim().split(/\s+/).filter(Boolean)) {
    const [key, value = ''] = token.split('=')
    if (key === 'hold') directive.hold = true
    else if (key === 'messages' || key === 'errors') directive[key] = Number(value)
    else if (key === 'memory') directive.memory = Number(value)
    else if (key === 'sets') {
      for (const item of value.split(',')) {
        const set = /^([A-Z]\d)\*(\d+)(?:@(\d+))?$/.exec(item)
        if (!set || !shapes[set[1]]) throw new RangeError('Unknown fake result set: ' + item)
        const rows = Number(set[2]), rate = set[3] === undefined ? undefined : Number(set[3])
        if (set[1] === 'M1') for (let i = 0; i < rows; i++) directive.sets.push({ shape: 'M1', rows: 1, rate })
        else directive.sets.push({ shape: set[1], rows, rate })
      }
    } else throw new RangeError('Unknown fake directive: ' + token)
  }
  return directive
}
