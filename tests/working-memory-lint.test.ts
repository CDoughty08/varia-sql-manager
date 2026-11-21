import { readdirSync, readFileSync } from 'node:fs'
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

// A windowed BigQuery result's block cache (RemoteResult.cs) reserves a block's estimate from the global budget before it
// fetches the block, within the cache's own limit, evicting its least recent blocks for room, and settles the difference
// once the pages are built; a seeded page is reserved before it is kept. Without them a cache would grow uncounted.
const remote = strip(readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'Results', 'RemoteResult.cs'), 'utf8'))
const between = (from: string, to: string) => remote.slice(remote.indexOf(from), remote.indexOf(to, remote.indexOf(from)))

it('reserves a block cache\'s bytes before it fetches or keeps a page', () => {
  const fetch = between('private async Task FetchAsync(', 'private void Reserve(')
  expect(fetch.indexOf('Reserve(estimate, block);')).toBeGreaterThan(0)
  expect(fetch.indexOf('Reserve(estimate, block);')).toBeLessThan(fetch.indexOf('await fetch(from, rows, writer, token);'))
  // The block is read in one place, however it is spelled, so nothing reads one before its reservation.
  expect(count(remote, /\bfetch(?:\.Invoke)?\s*\(/g)).toBe(1)
  expect(count(fetch, /\bfetch(?:\.Invoke)?\s*\(/g)).toBe(1)
  // The delegate is kept only in its field, never copied where a read could call it unreserved.
  expect(count(remote, /=\s*fetch\s*;/g)).toBe(1)
  // A failed fetch gives its estimate back; a built one settles what it really cost, an overrun reserved like the estimate
  // (within the cache's limit, else TOO_LARGE with the estimate given back), never charged past the limit.
  expect(count(fetch, /store\.ReturnCache\(ref held, estimate\);/g)).toBe(3)
  expect(fetch).toMatch(/if \(cost < estimate\) store\.ReturnCache\(ref held, estimate - cost\);\n\s*else if \(cost > estimate\)\n\s*\{\n\s*try \{ Reserve\(cost - estimate, block\); \}/)
  expect(remote).not.toMatch(/ForceCache|Interlocked\.Add\(ref held/)
  // The cache's charge changes only through the store's accounting (ref held), never by hand.
  expect(remote).not.toMatch(/\bheld\s*(?:[+\-]?=|\+\+|--)/)
  // A block is never built past the cache's limit (rows far wider than the first page's): the writer refuses it as it grows.
  expect(fetch).toMatch(/new RemoteBlockWriter\(resultId, wires, from, CacheLimit\)/)
  expect(remote).toMatch(/if \(builder\.IsFull\) Seal\(\);\n\s*if \(bytes > maxBytes\) throw BlockTooLarge\(\);/)
  expect(count(remote, /TryReserveCache\(/g)).toBe(count(remote, /TryReserveCache\(ref held, CacheLimit, /g))
  // A block's rows fit half its cache, so its capped estimate is what it should cost.
  expect(remote).toMatch(/var floor = \(int\)Math\.Clamp\(cacheLimit \/ 2 \/ bytes, 1, MinBlockRows\);/)
  // The reservation is the cache's own limit and the global budget, evicting blocks no read waits for, else TOO_LARGE.
  const reserve = between('private void Reserve(', 'private void EvictLocked(')
  expect(reserve).toMatch(/while \(!store\.TryReserveCache\(ref held, CacheLimit, bytes\)\)/)
  expect(reserve).toMatch(/block\.Waiters == 0 && block\.Fetching is null/)
  expect(reserve).toMatch(/throw new RequestException\("TOO_LARGE"/)
  const seed = between('public void Seed(', 'public async Task<long> ReadAsync(')
  expect(seed.indexOf('store.TryReserveCache(ref held, CacheLimit, page.Cost)')).toBeGreaterThan(0)
  // A refused reservation keeps no page.
  expect(seed).toMatch(/if \(!store\.TryReserveCache\(ref held, CacheLimit, page\.Cost\)\) (?:return|continue|break);/)
  expect(seed.indexOf('store.TryReserveCache(ref held, CacheLimit, page.Cost)')).toBeLessThan(seed.indexOf('block.Pages.Add(page);'))
  // Every charge of the cache goes through the store's cache accounting, which only the cache calls.
  expect(count(remote, /\bstore\.TryReserve(?:Work|Spare)?\(/g)).toBe(0)
  const backend = join(__dirname, '..', 'backend', 'Varia.Backend')
  const callers = (readdirSync(backend, { recursive: true }) as string[]).filter(name => name.endsWith('.cs') && !/(^|[\\/])(bin|obj)[\\/]/.test(name))
    .filter(name => /\bTryReserveCache\(/.test(strip(readFileSync(join(backend, name), 'utf8')))).map(name => name.replaceAll('\\', '/')).sort()
  expect(callers).toEqual(['Results/RemoteResult.cs', 'Results/ResultStore.cs'])
})
