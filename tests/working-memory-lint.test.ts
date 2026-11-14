import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Every operation on a whole result takes its working memory from the result budget before it builds, so a sort, profile,
// pivot or diff of a large result is refused (TOO_LARGE) rather than taking gigabytes the budget never counted. The
// operations still work without their reservation, and only a machine short of memory would show it, so no behaviour
// check sees one removed: this pins them in the source. Changing an operation's reservations means changing this table.
// Comments are dropped first: a reservation commented out is a reservation removed.
const source = readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'SqlService.cs'), 'utf8').replace(/\/\/.*$/gm, '')

const reservations: Record<string, RegExp> = {
  work: /\bstore\.TryReserveWork\(/g,
  spare: /\bstore\.TryReserveSpare\(/g,
  steps: /\bnew WorkSteps\(store, /g,
  // A WorkSteps built and not handed on reserves nothing: its TryReserve is what the operation is given.
  handed: /\b\w+\.TryReserve\b(?!\()/g,
  unpack: /\bawait Unpack\(/g
}

/** Each method's reservations, by kind. `unpack` is SqlService.Unpack, which reserves what unpacking packed pages takes. */
const expected: Record<string, Partial<Record<keyof typeof reservations, number>>> = {
  // A view's keys and filter (work), its collated keys (spare, through KeyMemory).
  ViewAsync: { work: 1, spare: 1, unpack: 1 },
  // A search holds a run of matches and a row's layouts, and reserves nothing (its comment says why).
  SearchAsync: { unpack: 1 },
  // Every thread's figures while there is room to spare, one thread's otherwise, and long values as they come.
  ProfileAsync: { work: 1, spare: 1, steps: 1, handed: 1, unpack: 1 },
  DistinctAsync: { work: 1, spare: 1, unpack: 1 },
  IdentifyAsync: { work: 1, unpack: 1 },
  Unpack: { work: 1 },
  // The alignment (work) and the differing cells (steps).
  DiffAsync: { work: 1, steps: 1, handed: 1, unpack: 1 },
  // The groups (work), the figures (steps) and the collated keys (spare).
  PivotAsync: { work: 1, spare: 1, steps: 1, handed: 1, unpack: 1 }
}

/** The body of the method `name` in SqlService.cs, from its first `{` to the matching `}`. */
function body(name: string): string {
  const header = new RegExp(`^    (?:private|internal|public)[^\\n=;]*\\b${name}\\(`, 'm').exec(source)
  if (!header) throw new Error(`SqlService.${name} was not found`)
  const open = source.indexOf('{', header.index)
  let depth = 0
  for (let at = open; at < source.length; at++) {
    if (source[at] === '{') depth++
    else if (source[at] === '}' && --depth === 0) return source.slice(open, at + 1)
  }
  throw new Error(`SqlService.${name} has no end`)
}

const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length
const counts = (text: string) => Object.fromEntries(Object.entries(reservations).map(([kind, pattern]) => [kind, count(text, pattern)]).filter(([, n]) => n))

it('keeps every working-memory reservation of the operations on results', () => {
  for (const [name, kinds] of Object.entries(expected)) expect({ name, ...counts(body(name)) }).toEqual({ name, ...kinds })
})

it('lists every method that reserves working memory, so a new one is added to the table', () => {
  // Every reservation in the file is in a listed method.
  const listed = Object.keys(expected).map(body).join('\n')
  for (const [kind, pattern] of Object.entries(reservations)) expect({ kind, count: count(listed, pattern) }).toEqual({ kind, count: count(source, pattern) })
  // And the lint sees what it pins: removing one reservation changes the counts.
  expect(counts(body('DiffAsync').replace(/\bstore\.TryReserveWork\(/, 'store.Return('))).not.toEqual(expected.DiffAsync)
  expect(counts(body('DiffAsync').replace(/cells\.TryReserve\b/, '_ => true'))).not.toEqual(expected.DiffAsync)
})
