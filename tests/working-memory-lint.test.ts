import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Every operation on a whole result takes its working memory from the result budget before it builds, so a sort, profile,
// pivot or diff of a large result is refused (TOO_LARGE) rather than taking gigabytes the budget never counted. The
// operations still work without their reservation, and only a machine short of memory would show it, so no behaviour
// check sees one removed: this pins them in the source. Changing an operation's reservations means changing this table.
// Comments and code compiled out are dropped first: a reservation commented out is a reservation removed.
// Strings are kept whole, so a // or /* inside one (a URL) does not drop the code after it.
const strip = (code: string) => code.replace(/#if false\b[\s\S]*?#endif/g, '')
  .replace(/(@"(?:[^"]|"")*"|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_, text?: string) => text ?? '')
it('drops comments but not code after a // inside a string', () => {
  expect(strip('const string Docs = "https://example.com"; Interlocked.Add(ref held, -bytes); // gone')).toBe('const string Docs = "https://example.com"; Interlocked.Add(ref held, -bytes); ')
  expect(strip('var a = @"x // ""y"""; b(); /* c */ d(\'/\');')).toBe('var a = @"x // ""y"""; b();  d(\'/\');')
})
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
// Both anchors must be found (comments are stripped, so a doc comment never anchors): a missing one fails, never a vacuous slice.
const between = (from: string, to: string) => {
  const start = remote.indexOf(from), end = start < 0 ? -1 : remote.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`anchor not found: ${start < 0 ? from : to}`)
  return remote.slice(start, end)
}

it('reads BigQuery\'s remote rows only through the block cache, and builds unlimited blocks only of the first page', () => {
  const backend = join(__dirname, '..', 'backend', 'Varia.Backend')
  const files = (readdirSync(backend, { recursive: true }) as string[]).filter(file => file.endsWith('.cs')).map(file => ({ file: file.replaceAll('\\', '/'), code: strip(readFileSync(join(backend, file), 'utf8')) }))
  const uses = (pattern: RegExp) => files.flatMap(({ file, code }) => Array.from(code.matchAll(pattern), () => file))
  // The fetch delegate is built once and handed only to the cache (Window's RemoteResult.Create), which reserves before it
  // calls it: nothing else may call it with a writer of its own.
  expect(uses(/\bBigQueryFetch\b/g)).toEqual(['SqlService.BigQueryResidence.cs', 'SqlService.BigQueryResidence.cs'])
  const residence = files.find(({ file }) => file === 'SqlService.BigQueryResidence.cs')!.code
  expect(residence).toMatch(/RemoteResult\.Create\([^;]*BigQueryFetch\(context\), context\);/)
  // ...and that Create is the only one: no second cache with a delegate of its own.
  expect(uses(/\bRemoteResult\.Create\(/g)).toEqual(['SqlService.BigQueryResidence.cs'])
  // A job's results are read where a query's own rows are (its first page, a script's statements, its pages under the
  // budget) and by Load into memory (RemoteQueryAsync): nowhere else reads a windowed result's rows around the cache.
  expect(uses(/\bQueryResultsAsync\(/g).sort()).toEqual(['BigQuery/BigQueryService.Jobs.cs', 'BigQuery/BigQueryService.Script.cs', ...Array(3).fill('SqlService.BigQueryExecution.cs'), 'SqlService.BigQueryResidence.cs'])
  const load = residence.indexOf('private async Task<QueryResult> RemoteQueryAsync(')
  expect(load).toBeGreaterThan(0)
  expect(residence.indexOf('bigQuery.QueryResultsAsync(')).toBeGreaterThan(load)
  expect(residence.indexOf('bigQuery.QueryResultsAsync(')).toBeLessThan(residence.indexOf('\n    }\n', load))
  // The cache fetches only for a read's own blocks and its read-ahead: results.rowBytes answers from the cache alone.
  expect(count(remote, /\bEnsure\(/g)).toBe(4)
  expect(count(between('public long[] RowBytes(', '\n    }\n'), /\b(?:Ensure|BlockLocked|FetchAsync)\(/g)).toBe(0)
  expect(residence).toMatch(/private RemoteFetch BigQueryFetch\(BigQueryWindow context\) =>/)
  // A table's rows are listed (tabledata.list) in TableRowsAsync, called from the delegate alone (a query's own rows, Load
  // into memory's included, come through its job's results under the budget), and by Preview Rows, which reads a table's
  // first rows into the tab's result store under the budget (a stored table the user chose, never a windowed result's).
  expect(uses(/\bTabledata\b/g).sort()).toEqual(['BigQuery/BigQueryService.Jobs.cs', 'SqlService.BigQueryPreview.cs'])
  const preview = files.find(({ file }) => file === 'SqlService.BigQueryPreview.cs')!.code
  expect(count(preview, /\bTabledata\.List\(args\.Project, args\.Dataset, args\.Table\)/g)).toBe(1)
  expect(preview).not.toMatch(/\bRemoteResult\b|\bBigQueryWindow\b|\bTableRowsAsync\b/)
  // ...and no other client reads rows: the typed client's row listings and query results and the resource classes, however
  // spelled, appear only in Jobs.cs's two requests (a job's results page and tabledata.list).
  // (Code only: a message naming tabledata.list reads nothing.)
  const codeUses = (pattern: RegExp) => files.flatMap(({ file, code }) => Array.from(code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').matchAll(pattern), () => file))
  expect(codeUses(/\b(?:[Tt]abledata\w*|TableDataList\w*|[Gg]etQueryResults\w*|ExecuteQuery\w*)\b|\bListRows\w*\s*\(/g).sort()).toEqual(['BigQuery/BigQueryService.Jobs.cs', 'BigQuery/BigQueryService.Jobs.cs', 'SqlService.BigQueryPreview.cs'])
  // The seeded cache goes straight to Demote, which keeps it (the set disposes it on release) or disposes it: no step
  // between can leave its first page charged with no owner.
  expect(residence).toMatch(/remote\.Seed\(seed\);\n\s*if \(!store\.Demote\(set, remote, total, bump: false\)\) return null;/)
  expect(count(residence, /\bremote\.Seed\(/g)).toBe(1)
  // Storage Read reads a query's own rows under the budget and Load into memory's: never a windowed result's rows around
  // the cache.
  expect(uses(/\bOpenReadSessionAsync\(/g).sort()).toEqual(['BigQuery/BigQueryService.Storage.cs', 'SqlService.BigQueryStorageRead.cs'])
  expect(uses(/\bBigQueryStorageSessionAsync\(/g).sort()).toEqual(['SqlService.BigQueryExecution.cs', 'SqlService.BigQueryResidence.cs', 'SqlService.BigQueryStorageRead.cs'])
  expect(uses(/\bReadBigQueryArrowAsync\(/g).sort()).toEqual(['SqlService.BigQueryExecution.cs', 'SqlService.BigQueryResidence.cs', 'SqlService.BigQueryStorageRead.cs'])
  for (const reader of ['BigQueryStorageSessionAsync(', 'ReadBigQueryArrowAsync(']) {
    const at = residence.indexOf(reader)
    expect(at).toBeGreaterThan(load)
    expect(at).toBeLessThan(residence.indexOf('\n    }\n', load))
  }
  // Google's read-session types appear only in the Storage client, its session and the reader of a session's streams.
  expect([...new Set(codeUses(/\b(?:ReadRowsRequest|ReadRowsResponse|CreateReadSession\w*|ReadSession)\b/g))].sort()).toEqual(['BigQuery/BigQueryService.Storage.cs', 'BigQuery/BigQueryStorage.cs', 'SqlService.BigQueryStorageRead.cs'])
  const jobs = files.find(({ file }) => file === 'BigQuery/BigQueryService.Jobs.cs')!.code
  const tableRows = jobs.slice(jobs.indexOf('internal Task<BigQueryPage> TableRowsAsync('))
  expect(tableRows.indexOf('\n\n    ')).toBeGreaterThan(0)
  expect(tableRows.slice(0, tableRows.indexOf('\n\n    ')).includes('service.Tabledata.List(')).toBe(true)
  // Every page of rows is read by SendRawAsync, called only for a job's results, for TableRowsAsync and by Preview Rows (its
  // table's metadata and its tabledata.list): no request of another shape (a table's data endpoint by hand) reaches it.
  expect(uses(/\bSendRawAsync\(/g).sort()).toEqual([...Array(3).fill('BigQuery/BigQueryService.Jobs.cs'), ...Array(2).fill('SqlService.BigQueryPreview.cs')])
  expect(count(tableRows.slice(0, tableRows.indexOf('\n\n    ')), /\bSendRawAsync\(service, request, t\)/g)).toBe(1)
  expect(count(jobs.slice(jobs.indexOf('async Task<BigQueryPage> ResultsPageAsync('), jobs.indexOf('internal Task<BigQueryPage> TableRowsAsync(')), /\bSendRawAsync\(service, request, token\)/g)).toBe(1)
  expect(uses(/\bTableRowsAsync\(/g).sort()).toEqual(['BigQuery/BigQueryService.Jobs.cs', 'SqlService.BigQueryResidence.cs'])
  const delegate = residence.slice(residence.indexOf('private RemoteFetch BigQueryFetch('))
  expect(delegate.slice(0, delegate.indexOf('\n    };')).includes('bigQuery.TableRowsAsync(')).toBe(true)
  // Each page it reads is written into the block's writer and disposed there: none is kept for a later block, and the
  // window it reads from carries no state of its own (a positional record with no body).
  expect(delegate.slice(0, delegate.indexOf('\n    };'))).toMatch(/using \(page\)\n\s*\{\n\s*var count = page\.RowCount;\n\s*WriteRows\(page, plan, writer, \(int\)\(rows - writer\.Rows\)\);/)
  expect(count(delegate.slice(0, delegate.indexOf('\n    };')), /\bpage\b/g)).toBe(6)
  expect(residence).toMatch(/internal sealed record BigQueryWindow\([^)]*long CacheBytes\);\n/)
  // Every mention of the writer type, however a writer is built (a target-typed new included), is one of these.
  expect(uses(/\bRemoteBlockWriter\b/g).sort()).toEqual([...Array(7).fill('Results/RemoteResult.cs'), ...Array(3).fill('SqlService.BigQueryResidence.cs')])
  // A writer without a byte limit holds only the first page, already in memory: its measure and its seed blocks.
  expect(uses(/new RemoteBlockWriter\(/g).sort()).toEqual(['Results/RemoteResult.cs', 'SqlService.BigQueryResidence.cs', 'SqlService.BigQueryResidence.cs'])
  const decide = residence.slice(residence.indexOf('DecideResidenceAsync('), residence.indexOf('async Task<RemoteResult?> KeepInMemoryAsync()'))
  expect(count(decide, /new RemoteBlockWriter\(set\.ResultId, set\.Wires, (0|from)\);/g)).toBe(2)
  expect(count(decide, /WriteRows\(first, plan, /g)).toBe(2)
})

it('reserves a block cache\'s bytes before it fetches or keeps a page', () => {
  const fetch = between('private async Task FetchAsync(', 'private bool Reserve(')
  expect(fetch.indexOf('if (!Reserve(estimate, block))')).toBeGreaterThan(0)
  expect(fetch.indexOf('if (!Reserve(estimate, block))')).toBeLessThan(fetch.indexOf('await fetch(from, rows, writer, token);'))
  // The block is read in one place, however it is spelled, so nothing reads one before its reservation.
  // The delegate appears only as its field, Create's parameter and its pass to the constructor, the constructor's parameter
  // and assignment (two), and that one call: never passed on, copied or called another way where a read could reach it
  // unreserved.
  expect(remote.match(/\bfetch\b/g)).toHaveLength(7)
  for (const spelling of ['private readonly RemoteFetch fetch;', 'RemoteFetch fetch, object? source = null) => new(store, resultId, wires, rows, capped, rowBytes, cacheLimit, connectionLane, fetch) { Source = source };', 'RemoteFetch fetch)', 'this.fetch = fetch;', 'await fetch(from, rows, writer, token);']) expect(remote).toContain(spelling)
  expect(count(fetch, /\bfetch\s*\(/g)).toBe(1)
  // A failed fetch gives its estimate back; a built one settles what it really cost, an overrun reserved like the estimate
  // (within the cache's limit, else TOO_LARGE with the estimate given back), never charged past the limit.
  expect(count(fetch, /store\.ReturnCache\(ref held, estimate\);/g)).toBe(3)
  expect(fetch).toMatch(/var cost = pages\.Sum\(page => page\.Cost\);\n(\s*\/\/[^\n]*\n)*\s*if \(writer\.Rows > 0\) lock \(gate\) widestRowBytes = Math\.Max\(widestRowBytes, \(double\)cost \/ writer\.Rows\);\n\s*if \(cost < estimate\) store\.ReturnCache\(ref held, estimate - cost\);\n\s*else if \(cost > estimate\)\n\s*\{\n\s*try \{ await ReserveOverrunAsync\(cost - estimate, block, token\); \}/)
  // An overrun reserves through Reserve too; refused by the cache's own limit, it may pass it, up to twice it (OverLimit),
  // and the global budget still refuses it. Which limit refused is what the reservation saw: never decided again from the
  // cache's bytes afterwards, which other fetches change meanwhile.
  const overrun = between('private async Task ReserveOverrunAsync(', 'private bool Reserve(')
  expect(overrun).toMatch(/\{\n\s*if \(Reserve\(bytes, keep\)\) return;\n/)
  // A block only read ahead stops there instead: only blocks reads wait for pass the limit.
  expect(overrun).toMatch(/if \(others\.Length == 0 \|\| round > 0\)\n\s*\{\n(\s*\/\/[^\n]*\n)*\s*bool ahead;\n\s*lock \(gate\) ahead = keep\.Waiters == 0 && keep\.AheadOf != 0;\n\s*if \(ahead\) throw new RemoteRetryException\(RemoteBlockWriter\.CacheTooSmall\(\)\);\n\s*if \(store\.TryReserveCache\(ref held, OverLimit, bytes, out var full\)\) \{ NotePeak\(\); return; \}\n(\s*\/\/[^\n]*\n)*\s*throw full \? RemoteBlockWriter\.CacheTooSmall\(\) : BudgetFull\(\);/)
  // The cache's bytes are read in two places only: CachedBytes, and the trim's loop. Only read-ahead's reach check refuses
  // by CachedBytes (a stale figure skips one read-ahead or wastes one eviction); every other refusal is the store's.
  expect(count(remote, /\bCachedBytes\b/g)).toBe(3)
  expect(between('private bool Reserve(', 'private void EvictLocked(')).toMatch(/if \(CachedBytes - evictable \+ bytes > limit\) return false;/)
  expect(count(remote, /Interlocked\.Read\(ref held\)/g)).toBe(2)
  expect(remote).toMatch(/public long CachedBytes => Interlocked\.Read\(ref held\);/)
  expect(remote).toMatch(/while \(Interlocked\.Read\(ref held\) > CacheLimit\)/)
  // The limits are what they say: CacheLimit set once, in the constructor, and never shadowed; OverLimit twice it.
  expect(count(remote, /\bCacheLimit\s*=[^=>]/g)).toBe(1)
  expect(remote).toMatch(/\n\s*CacheLimit = Math\.Max\(TargetBlockBytes, cacheLimit\);\n/)
  expect(remote).toMatch(/public long CacheLimit \{ get; \}/)
  expect(count(remote, /\bOverLimit\s*=[^=>]/g)).toBe(0)
  expect(remote).not.toMatch(/\b(?:long|var|int|double)\s+(?:CacheLimit|OverLimit)\b(?!\s*(?:\{ get; \}|=>))/)
  const reserveBody = between('private bool Reserve(', 'private void EvictLocked(')
  // Its limit is the cache's own, less (for a block only read ahead) the estimates of read blocks that have not reserved yet:
  // never more than CacheLimit.
  expect(reserveBody).toMatch(/\{\n\s*lock \(gate\)\n\s*\{\n\s*var ahead = keep\.Waiters == 0 && keep\.AheadOf != 0;\n\s*var limit = CacheLimit;\n\s*if \(ahead\)\n\s*\{\n\s*limit -= blocks\.Values\.Where\([^\n]*\)\.Sum\(block => Math\.Min\(EstimateOf\([^\n]*\), CacheLimit \/ 2\)\);\n\s*var evictable = lru\.Where\(block => block != keep && block\.Waiters == 0 && block\.Fetching is null && block\.Bytes > 0 && !OnScreenLocked\(block\)\)\.Sum\(block => block\.Bytes\);\n\s*if \(CachedBytes - evictable \+ bytes > limit\) return false;\n\s*\}\n\s*while \(!store\.TryReserveCache\(ref held, limit, bytes, out var full\)\)\n\s*\{\n\s*if \(ahead && !full\) return false;\n\s*var victim = VictimLocked\(keep, ahead\);\n\s*if \(victim is null\) return full \? false : throw BudgetFull\(\);\n\s*EvictLocked\(victim\);\n\s*\}\n\s*keep\.Holding = true;\n\s*\}\n\s*NotePeak\(\);\n\s*return true;/)
  // A block's room and its Holding mark change together under the gate, on both reservations: no read-ahead counts it twice.
  expect(fetch).toMatch(/lock \(gate\)\n\s*\{\n\s*if \(!store\.TryReserveCache\(ref held, OverLimit, estimate, out var full\)\) throw full \? RemoteBlockWriter\.CacheTooSmall\(\) : BudgetFull\(\);\n\s*block\.Holding = true;\n\s*\}/)
  expect(count(remote, /\.Holding = true/g)).toBe(2)
  expect(count(reserveBody, /\blimit\s*(?:[-+*/%&|^]|<<|>>>?|\?\?)?=(?!=)|(?:\+\+|--)\s*limit\b|\blimit\s*(?:\+\+|--)|\b(?:ref|out|in)\s+limit\b/g)).toBe(2)
  // What it subtracts is a sum of estimates (each at least the page overhead), never negative, so the limit only falls.
  expect(reserveBody.includes('limit -= blocks.Values.Where(block => block != keep && block.Waiters > 0 && block.Fetching is not null && !block.Holding).Sum(block => Math.Min(EstimateOf((int)(block.End - block.Filled)), CacheLimit / 2));')).toBe(true)
  // The store refuses past the limit it is given, and past the global budget, before it counts anything.
  const storeCode = strip(readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'Results', 'ResultStore.cs'), 'utf8'))
  const tryCache = storeCode.slice(storeCode.indexOf('public bool TryReserveCache(ref long held, long limit, long bytes, out bool overLimit)'))
  expect(tryCache.slice(0, tryCache.indexOf('\n    }\n'))).toMatch(/overLimit = false;\n\s*if \(bytes <= 0\) return true;\n\s*if \(Interlocked\.Add\(ref held, bytes\) > limit\)\n\s*\{\n\s*Interlocked\.Add\(ref held, -bytes\);\n\s*overLimit = true;\n\s*return false;\n\s*\}\n\s*var global = Volatile\.Read\(ref figures\)\.Global;\n\s*for \(var current = Interlocked\.Read\(ref used\); ; current = Interlocked\.Read\(ref used\)\)\n\s*\{\n\s*if \(current \+ bytes > global\)\n\s*\{\n\s*Interlocked\.Add\(ref held, -bytes\);\n\s*return false;\n\s*\}\n\s*if \(Interlocked\.CompareExchange\(ref used, current \+ bytes, current\) == current\) break;\n\s*\}\n\s*Interlocked\.Add\(ref windowCacheUsed, bytes\);\n\s*return true;$/)
  expect(reserveBody).toMatch(/if \(victim is null\) return full \? false : throw BudgetFull\(\);/)
  // A block's estimate the cache's own limit refuses: read ahead only, it stops with nothing fetched; one a read waits for
  // passes the limit, up to twice it (OverLimit, through the global budget), else TOO_LARGE naming the cache.
  // What it reserves is the block's estimate, never less.
  expect(fetch).toMatch(/var estimate = Math\.Min\(EstimateOf\(rows\), CacheLimit \/ 2\);\n(\s*\/\/[^\n]*\n)*\s*if \(!Reserve\(estimate, block\)\)/)
  expect(count(fetch, /\bestimate = /g)).toBe(1)
  expect(fetch).toMatch(/if \(!Reserve\(estimate, block\)\)\n\s*\{\n(\s*\/\/[^\n]*\n)*\s*bool waited;\n\s*lock \(gate\) waited = block\.Waiters > 0;\n\s*if \(!waited\) throw new RemoteRetryException\(RemoteBlockWriter\.CacheTooSmall\(\)\);\n\s*lock \(gate\)\n\s*\{\n\s*if \(!store\.TryReserveCache\(ref held, OverLimit, estimate, out var full\)\) throw full \? RemoteBlockWriter\.CacheTooSmall\(\) : BudgetFull\(\);\n\s*block\.Holding = true;\n\s*\}\n\s*NotePeak\(\);\n\s*\}/)
  expect(remote).toMatch(/private long OverLimit => CacheLimit \* 2;/)
  // A refused overrun, whatever refused it, gives back the block's estimate before the failure goes on.
  expect(fetch).toMatch(/try \{ await ReserveOverrunAsync\(cost - estimate, block, token\); \}\n\s*catch\n\s*\{\n\s*store\.ReturnCache\(ref held, estimate\);\n\s*throw;\n\s*\}/)
  // ...and the cache trims back to its limit when a read lets go of its blocks and when a fetch settles.
  expect(count(remote, /TrimLocked\(\);/g)).toBe(2)
  // Each where it belongs, under the gate: after a read drops its holds, and after a fetch settles.
  expect(remote).toMatch(/DropIfIdleLocked\(block\);\n\s*\}\n\s*TrimLocked\(\);\n\s*\}\n\s*\}\n\s*\}/)
  expect(remote).toMatch(/DropIfIdleLocked\(block\);\n\s*TrimLocked\(\);\n\s*\}\n\s*stop\.Dispose\(\);/)
  // A block that lands after the cache was disposed or the block replaced gives back what it cost.
  expect(fetch).toMatch(/cached != block\)\n\s*\{\n\s*store\.ReturnCache\(ref held, cost\);\n\s*return;/)
  // A trim evicts only what Reserve may: blocks no read waits for and no fetch is filling.
  const trim = between('private void TrimLocked(', 'private bool Reserve(')
  expect(trim).toMatch(/while \(Interlocked\.Read\(ref held\) > CacheLimit\)/)
  expect(trim).toMatch(/var victim = VictimLocked\(null, ahead: false\);/)
  // Victims are the least recent off screen first; rows on screen go only when nothing else is left, never for read-ahead.
  expect(between('private Block? VictimLocked(', 'internal bool OnScreenForChecks(')).toMatch(/\{\n\s*Block\? onScreen = null;\n\s*foreach \(var block in lru\)\n\s*\{\n\s*if \(block == keep \|\| block\.Waiters > 0 \|\| block\.Fetching is not null \|\| block\.Bytes <= 0\) continue;\n\s*if \(!OnScreenLocked\(block\)\) return block;\n\s*onScreen \?\?= block;\n\s*\}\n\s*return ahead \? null : onScreen;\n\s*\}/)
  expect(count(remote, /\bVictimLocked\(/g)).toBe(3)
  expect(count(remote, /\bEvictLocked\(/g)).toBe(5)
  expect(remote).not.toMatch(/ForceCache|Interlocked\.Add\(ref held/)
  // The cache's charge changes only through the store's accounting, never by hand: every use of it is one of these.
  const heldUses = remote.replace(/private long held;|Interlocked\.Read\(ref held\)|store\.(?:TryReserveCache|ReturnCache)\(ref held, /g, '')
  expect(heldUses).not.toMatch(/\bheld\b/)
  // Every give-back is one of these, each of bytes the cache charged: none drifts the charge below what it holds.
  expect(count(remote, /\bReturnCache\b/g)).toBe(6)
  expect(Array.from(remote.matchAll(/store\.ReturnCache\(ref held, ([^;]*)\);/g), match => match[1])).toEqual(['estimate', 'estimate', 'estimate - cost', 'estimate', 'cost', 'bytes'])
  expect(between('private void EvictLocked(', 'private void ReadAhead(')).toMatch(/var bytes = block\.Bytes;\n\s*block\.Bytes = 0;[\s\S]*store\.ReturnCache\(ref held, bytes\);/)
  // Pages are kept in two places only: Seed's one reserved page, and a fetch's settled pages.
  expect(count(remote, /\bPages\s*\.\s*(?:Add|AddRange|Insert|InsertRange)\b|\bPages\s*\[/g)).toBe(2)
  expect(count(between('public void Seed(', 'public async Task<long> ReadAsync('), /block\.Pages\.Add\(page\);/g)).toBe(1)
  expect(count(fetch, /block\.Pages\.AddRange\(pages\);\n\s*block\.Bytes \+= cost;/g)).toBe(1)
  // No other container keeps pages (an evicted block's kept for scroll-back would grow uncounted): every mention of the page
  // type and of a block's pages is one of today's.
  expect(count(remote, /\bRemotePage\b/g)).toBe(8)
  expect(count(remote, /\bPages\b/g)).toBe(7)
  // A page costs the cache what a stored page costs the store: both charges are this one formula, so neither drifts alone.
  expect(remote).toMatch(/public long Cost => Body\.Length \+ ResultStore\.PageOverhead \+ Lengths\.MemoryBytes;/)
  const bufferCode = strip(readFileSync(join(__dirname, '..', 'backend', 'Varia.Backend', 'Results', 'ResultSetBuffer.cs'), 'utf8'))
  expect(bufferCode).toMatch(/var cost = page\.Length \+ ResultStore\.PageOverhead \+ lengths\.MemoryBytes;/)
  // The figures reserved and settled are never changed after they are computed: each is assigned once.
  const writes = (code: string, name: string) => count(code, new RegExp(`\\b${name}\\s*(?:[-+*/%&|^]|<<|>>>?|\\?\\?)?=(?!=)|(?:\\+\\+|--)\\s*${name}\\b|\\b${name}\\s*(?:\\+\\+|--)|\\b(?:ref|out)\\s+${name}\\b`, 'g'))
  expect([writes(fetch, 'estimate'), writes(fetch, 'cost')]).toEqual([1, 1])
  expect([writes(between('private bool Reserve(', 'private void EvictLocked('), 'bytes'), writes(between('private async Task ReserveOverrunAsync(', 'private bool Reserve('), 'bytes')]).toEqual([0, 0])
  // A seeded block's charge is the sum of its pages', and the store gives back exactly what it is told on every counter.
  expect(count(between('public void Seed(', 'public async Task<long> ReadAsync('), /block\.Bytes \+= page\.Cost;/g)).toBe(1)
  expect(count(remote, /\bblock\.Bytes\s*(?:[-+*/%&|^]|<<|>>>?|\?\?)?=(?!=)/g)).toBe(3)
  const returnCache = storeCode.slice(storeCode.indexOf('public void ReturnCache(ref long held, long bytes)'))
  expect(returnCache.slice(0, returnCache.indexOf('\n    }\n'))).toMatch(/\{\n\s*if \(bytes <= 0\) return;\n\s*Interlocked\.Add\(ref held, -bytes\);\n\s*Interlocked\.Add\(ref windowCacheUsed, -bytes\);\n\s*Interlocked\.Add\(ref used, -bytes\);\n\s*RoomChanged\(\);\n\s*Freed\(bytes\);$/)
  // Disposing gives every block's bytes back through the same eviction.
  expect(remote).toMatch(/disposed\.Cancel\(\);\n\s*foreach \(var block in blocks\.Values\.ToList\(\)\) EvictLocked\(block\);/)
  expect(count(remote, /\bblocks\s*\.\s*(?:Clear|Remove)\b/g)).toBe(2)
  // An evicted block keeps no pages, and blocks are held only by the cache's own two lists (and a block's own node): no
  // scroll-back queue keeps evicted blocks' pages after their bytes went back.
  expect(between('private void EvictLocked(', 'private void ReadAhead(')).toMatch(/block\.Bytes = 0;\n\s*block\.Pages\.Clear\(\);/)
  expect(Array.from(remote.matchAll(/(?:private|internal|public|protected)\s+(?:static\s+)?(?:readonly\s+)?[^;=(\n]*\bBlock\b[^;=(\n]*\s(\w+)\s*[;=]/g), match => match[1])).toEqual(['blocks', 'lru', 'Node'])
  // The rows on screen are every block a viewer's last read covered.
  expect(remote).toMatch(/private bool OnScreenLocked\(Block block\) => viewers\.Values\.Any\(viewer => viewer\.First >= 0 && block\.Index >= viewer\.First && block\.Index <= viewer\.Last\);/)
  // Seed's reservation is the same refusing one: the short overload only drops the reason.
  expect(storeCode).toMatch(/public bool TryReserveCache\(ref long held, long limit, long bytes\) => TryReserveCache\(ref held, limit, bytes, out _\);/)
  expect(count(storeCode, /\bbool\s+TryReserveCache\s*\(/g)).toBe(2)
  // The writer's byte count grows by every page it seals, and nowhere else, so its limit holds.
  const writer = remote.slice(remote.indexOf('internal sealed class RemoteBlockWriter('), remote.indexOf('internal sealed class RemoteExpiredException'))
  expect(writer).toMatch(/private void Seal\(\)\n\s*\{[^}]*\bbytes \+= page\.Cost;/)
  expect(count(writer, /\bbytes\s*(?:[-+*/%&|^]|<<|>>>?|\?\?)?=(?!=)|(?:\+\+|--)\s*bytes\b|\bbytes\s*(?:\+\+|--)|\b(?:ref|out)\s+bytes\b/g)).toBe(1)
  // A block is never built past the cache's limit (rows far wider than the first page's): the writer refuses it as it grows.
  expect(fetch).toMatch(/new RemoteBlockWriter\(resultId, wires, from, CacheLimit\)/)
  expect(remote).toMatch(/if \(builder\.IsFull\) Seal\(\);\n\s*if \(bytes > maxBytes\) throw BlockTooLarge\(\);/)
  expect(count(remote, /TryReserveCache\(/g)).toBe(count(remote, /TryReserveCache\(ref held, CacheLimit, /g) + count(reserveBody, /TryReserveCache\(ref held, limit, /g) + count(overrun, /TryReserveCache\(ref held, OverLimit, /g) + count(fetch, /TryReserveCache\(ref held, OverLimit, estimate, /g))
  expect(count(overrun, /TryReserveCache\(ref held, OverLimit, /g)).toBe(1)
  expect(count(remote, /TryReserveCache\(ref held, OverLimit, /g)).toBe(2)
  // The last page is checked too: no block costs more than its cache.
  expect(remote).toMatch(/if \(builder\.HasRows\) Seal\(\);\n\s*if \(bytes > maxBytes\) throw BlockTooLarge\(\);/)
  // A block's rows fit half its cache with the estimate's own margin, so a block and one read ahead fit it even a little wider.
  expect(remote).toMatch(/var floor = \(int\)Math\.Clamp\(cacheLimit \/ 2 \/ \(bytes \* EstimateMargin\), 1, MinBlockRows\);/)
  expect(remote).toMatch(/private const double EstimateMargin = 1\.25;/)
  // The whole estimate, of the measured row cost as given: never scaled down where blocks are sized from the same figure.
  expect(remote).toMatch(/private long EstimateOf\(int rows\) => \(long\)Math\.Ceiling\(rows \* rowBytes \* EstimateMargin\) \+ ResultStore\.PageOverhead;\n/)
  expect(remote).toMatch(/private readonly double rowBytes;/)
  expect(remote).toMatch(/this\.rowBytes = Math\.Max\(1, rowBytes\);\n/)
  expect(count(remote, /\browBytes\s*=[^=]/g)).toBe(1)
  expect(remote).toMatch(/BlockRows = BlockRowsFor\(rowBytes, CacheLimit\);/)
  // The reservation is the cache's own limit and the global budget, evicting blocks no read waits for, else TOO_LARGE.
  const reserve = between('private bool Reserve(', 'private void EvictLocked(')
  expect(reserve).toMatch(/while \(!store\.TryReserveCache\(ref held, limit, bytes, out var full\)\)/)
  expect(reserve).toMatch(/block\.Waiters == 0 && block\.Fetching is null/)
  expect(reserve).toMatch(/private static RequestException BudgetFull\(\) =>\n\s*new\("TOO_LARGE", /)
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
  // The checks above read RemoteResult.cs alone: the cache stays one class in that one file, so no partial file escapes them.
  const declared = (readdirSync(backend, { recursive: true }) as string[]).filter(name => name.endsWith('.cs') && !/(^|[\\/])(bin|obj)[\\/]/.test(name))
    .filter(name => /\bclass\s+RemoteResult\b/.test(strip(readFileSync(join(backend, name), 'utf8')))).map(name => name.replaceAll('\\', '/'))
  expect(declared).toEqual(['Results/RemoteResult.cs'])
  expect(remote).not.toMatch(/\bpartial\b[^{;]*\bclass\s+RemoteResult\b/)
})
