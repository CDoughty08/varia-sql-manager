import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Every operation on a whole result takes its working memory from the result budget before it builds, so a sort, profile,
// pivot or diff of a large result is refused (TOO_LARGE) rather than taking gigabytes the budget never counted. The
// operations still work without their reservation, and only a machine short of memory would show it, so no behaviour
// check sees one removed: this pins them in the source. Changing an operation's reservations means changing this table.
// Comments and code compiled out are dropped first: a reservation commented out is a reservation removed.
const strip = (code: string) => code.replace(/#if false\b[\s\S]*?#endif/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const source = strip(readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'SqlService.cs'), 'utf8'))

const reservations: Record<string, RegExp> = {
  // Refused, it ends the operation: every one is tested.
  work: /!store\.TryReserveWork\(/g,
  spare: /\bstore\.TryReserveSpare\(/g,
  steps: /\bnew WorkSteps\(store, /g,
  // A WorkSteps built and not handed on reserves nothing: its TryReserve is what the operation is given.
  handed: /\b\w+\.TryReserve\b(?!\()/g
}

/** Each method's reservations, by kind. A view, a profile, a pivot, a distinct list, row identities, a diff and a search
 * (through any view, ResultSearcher.ByPages) read a packed result fused: their rooms and extracts are reserved where they
 * are read (ViewSorter.PageSource, PageRooms, RowAccess.Hold), and FusedReadChecks' refusal checks pin them. */
const expected: Record<string, Partial<Record<keyof typeof reservations, number>>> = {
  // A view's keys and filter (work), its collated keys (spare, through KeyMemory).
  ViewAsync: { work: 1, spare: 1 },
  // A search holds a run of matches and a row's layouts and reserves nothing for them (its comment says why); through a
  // view far from a packed result's pages it reserves the view's inverse where it reads (ResultSearcher.ByPages, whose
  // refusal FusedReadChecks pins) and never unpacks.
  SearchAsync: {},
  // Every thread's figures while there is room to spare, one thread's otherwise, and long values as they come.
  ProfileAsync: { work: 1, spare: 1, steps: 1, handed: 1 },
  DistinctAsync: { work: 1, spare: 1 },
  IdentifyAsync: { work: 1 },
  // The alignment and the change index (work; the index's refusal is DiffChecks' IndexCharge), the cut rows' bitsets (handed
  // to the index's builder; its refusal is DiffChecks' EntryCutRows) and the differing cells (steps). DiffAsync validates first.
  DiffWritten: { work: 2, steps: 1, handed: 1 },
  // The groups (work), the figures (steps) and the collated keys (spare).
  PivotAsync: { work: 1, spare: 1, steps: 1, handed: 1 }
}

/** What each method hands the code that builds: a reservation made and not passed on reserves nothing. */
const handoffs: Record<string, RegExp[]> = {
  ViewAsync: [/\bViewSorter\.Build\([^;]*\bkeyMemory\)/],
  ProfileAsync: [/\bnew ColumnProfiler\.Charges\(steps\.TryReserve\)/, /\bColumnProfiler\.Profile\([^;]*\bcharges\b/],
  DistinctAsync: [/\bViewSorter\.DistinctValues\([^;]*\bkeyMemory\)/],
  DiffWritten: [/\bResultDiffer\.Compare\([^;]*\bcells\.TryReserve\b/, /\bnew DiffIndex\.Builder\([^;]*\bstore\.TryReserveWork\(left\.Budget, bytes\)\)/],
  PivotAsync: [/\bResultPivoter\.Build\([^;]*\bfigures\.TryReserve, keyMemory\)/]
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

it('hands every reservation on to the code that builds', () => {
  for (const [name, patterns] of Object.entries(handoffs)) for (const pattern of patterns) expect({ name, pattern: String(pattern), found: pattern.test(body(name)) }).toEqual({ name, pattern: String(pattern), found: true })
  // The lint sees a reservation dropped on the way: a profile given no charges budgets nothing.
  expect(handoffs.ProfileAsync[1].test(body('ProfileAsync').replace('work, charges, threads', 'work, null, threads'))).toBe(false)
})

it('lists every method that reserves working memory, so a new one is added to the table', () => {
  // Every reservation in the file is in a listed method.
  const listed = Object.keys(expected).map(body).join('\n')
  for (const [kind, pattern] of Object.entries(reservations)) expect({ kind, count: count(listed, pattern) }).toEqual({ kind, count: count(source, pattern) })
  // However it is written: a reservation tested the other way round, kept in a variable or made directly.
  const any = /\bstore\.TryReserve(?:Work|Spare)?\(/g
  expect(count(listed, any)).toBe(count(source, any))
  expect(count('if (store.TryReserveWork(budget, bytes)) { } var ok = store.TryReserve(budget, bytes, true, out _);', any)).toBe(2)
  // And the lint sees what it pins: removing one reservation changes the counts.
  expect(counts(body('DiffWritten').replace(/\bstore\.TryReserveWork\(/, 'store.Return('))).not.toEqual(expected.DiffWritten)
  expect(counts(body('DiffWritten').replace(/cells\.TryReserve\b/, '_ => true'))).not.toEqual(expected.DiffWritten)
  // Commented or compiled out, it is gone too.
  expect(counts(strip(body('DiffWritten').replace('!store.TryReserveWork(left.Budget, working)', 'false /* !store.TryReserveWork(left.Budget, working) */')))).not.toEqual(expected.DiffWritten)
  expect(counts(strip(body('PivotAsync').replace(/^.*figures\.TryReserve, keyMemory.*$/m, line => `#if false\n${line}\n#endif`)))).not.toEqual(expected.PivotAsync)
})
