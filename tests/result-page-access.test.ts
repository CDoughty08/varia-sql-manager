import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Stored result pages are read through one accessor (StoredPage.Body(), which is ResultSetBuffer.Body) while their result
// is pinned, because the store may keep a page packed (PackedPage) rather than as the bytes it sealed. A reader that took
// the form the store keeps would read packed bytes as a page and fail, so only ResultSetBuffer.cs touches it, and
// PackingChecks.cs, which checks which form each page is in. The .NET checks pin-check every read at run time
// (ResultSetBuffer.RequirePins) and run the result suites a second time with every result packed; this catches a reader
// the checks do not reach.
const roots = ['backend/Varia.Backend', 'backend/Varia.Backend.Tests']
const sources = roots.flatMap(root => (readdirSync(root, { recursive: true }) as string[])
  .filter(name => name.endsWith('.cs') && !/[\\/](bin|obj)[\\/]/.test(`/${name}`))
  .map(name => join(root, name).replaceAll('\\', '/')))
const accessor = 'backend/Varia.Backend/Results/ResultSetBuffer.cs'

function lines(pattern: RegExp, except: string[]) {
  return sources.filter(file => !except.includes(file)).flatMap(file => readFileSync(file, 'utf8').split('\n')
    .map((line, index) => [file, index + 1, line] as const)).filter(([, , line]) => pattern.test(line)).map(([file, line]) => `${file}:${line}`)
}

describe('result page access', () => {
  it('finds the backend and check sources', () => {
    expect(sources).toEqual(expect.arrayContaining([accessor, 'backend/Varia.Backend/Results/ResultViews.cs', 'backend/Varia.Backend/SqlService.cs',
      'backend/Varia.Backend.Tests/StoreChecks.cs', 'backend/Varia.Backend.Tests/PackingChecks.cs']))
  })
  it('keeps the stored form of a page inside ResultSetBuffer', () => {
    const source = readFileSync(accessor, 'utf8')
    expect(source).toMatch(/internal object Stored \{ get => Volatile\.Read\(ref stored\); set => Volatile\.Write\(ref stored, value\); \}/)
    expect(source).toMatch(/public byte\[\] Body\(\) => Set is null \? \(byte\[\]\)Stored : Set\.Body\(this\);/)
    expect(source).toMatch(/return page\.Stored as byte\[\] \?\? Unpacked\(page\);/)
    expect(lines(/\.Stored\b(?!\()/, [accessor, 'backend/Varia.Backend.Tests/PackingChecks.cs'])).toEqual([])
    // A property pattern (page is { Stored: var bytes }) reads it as well.
    expect(lines(/\bStored\s*:(?!:)/, [accessor, 'backend/Varia.Backend.Tests/PackingChecks.cs'])).toEqual([])
  })
  it('stores pages only through ResultSetBuffer, and builds set-less pages only for a view read and the compression benchmark', () => {
    // The compression benchmark (run by hand) builds set-less pages from bytes it unpacked itself: its own, as a view's are.
    expect(lines(/new StoredPage\(/, [accessor, 'backend/Varia.Backend/Results/ResultViews.cs', 'backend/Varia.Backend.Tests/PageCompressionBench.cs'])).toEqual([])
    const bench = readFileSync('backend/Varia.Backend.Tests/PageCompressionBench.cs', 'utf8')
    expect([...bench.matchAll(/new StoredPage\(([^;]*)\);/g)].map(match => match[1].split(',').length)).toEqual([4, 4])
    const views = readFileSync('backend/Varia.Backend/Results/ResultViews.cs', 'utf8')
    expect([...views.matchAll(/new StoredPage\(([^;]*)\);/g)].map(match => match[1].split(',').length)).toEqual([4, 4])
  })
  it('refuses a windowed BigQuery result in every reader of stored pages before it does any work (REMOTE_RESULT)', () => {
    // A windowed result has no stored pages: its rows stay in BigQuery (docs/architecture.md, Results). Each reader finds its
    // set through Stored(...), which answers REMOTE_RESULT; only these find a set another way, each for its own reason.
    // Inside the store's own partial files a bare Find( is the store's; everywhere else any spelling of a store's Find(.
    // Whatever a store is called (store, _store, Results, resultStore), and its partial files' own bare calls.
    const service = sources.filter(file => file.startsWith('backend/Varia.Backend/'))
    // Null-conditional and null-forgiving calls, and a method group (no parenthesis), count too.
    const anyStore = /\b\w*(?:[sS]tore|[rR]esults)[?!]?\.Find\b/g
    const finds = (file: string) => /\/ResultStore(?:\.[^/]+)?\.cs$/.test(file) ? new RegExp(`(?:^|[^\\w.]|\\bthis\\.)Find\\(|${anyStore.source}`, 'g') : anyStore
    // Each call is counted, not each line (a guarded Find does not excuse another on its line), and a call split before
    // its .Find is joined to its receiver's line first.
    const unguardedIn = (file: string, text: string) => text.replace(/\s*\r?\n\s*(?=[?!]?\.Find\b)/g, '').split('\n')
      .filter(line => !/^\s*\/\//.test(line) && !/public ResultSetBuffer\? Find\(/.test(line)
        && (line.match(finds(file)) ?? []).length > (line.match(/\bStored\(store\.Find\(/g) ?? []).length)
      .map(line => `${file.replace('backend/Varia.Backend/', '')}: ${line.trim()}`)
    expect(unguardedIn('backend/Varia.Backend/X.cs', 'var left = Stored(store.Find(a) ?? throw U(a)); var right = store.Find(b)!;')).toHaveLength(1)
    expect(unguardedIn('backend/Varia.Backend/X.cs', 'var set = store\n    .Find(id);')).toEqual(['X.cs: var set = store.Find(id);'])
    expect(unguardedIn('backend/Varia.Backend/X.cs', 'var set = Stored(store.Find(id) ?? throw U(id));')).toEqual([])
    const unguarded = service.flatMap(file => unguardedIn(file, readFileSync(file, 'utf8')))
    expect(unguarded.sort()).toEqual([
      // Visibility only asks whether the result exists.
      'SqlService.cs: visibility = new ResultVisibility(id => this.store.Find(id) is not null);',
      // results.read and results.rowBytes route a windowed result to its block cache (ReadRemoteAsync, RemoteResult.RowBytes).
      'SqlService.cs: var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);',
      'SqlService.cs: var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);',
      // A comparison being replaced is a diff the backend built in memory, never windowed.
      'SqlService.cs: var replaced = store.Find(replacedId) ?? throw Unavailable(replacedId);',
      // Copy and Save find their set through ResultJobs.Lease, which refuses a windowed one (pinned below).
      'Results/ResultJobs.cs: var set = store.Find(resultId);',
      // Load into memory is the one request that wants the windowed result.
      'SqlService.BigQueryResidence.cs: var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);'
    ].sort())
    // Nor does a reader reach a set around Find: no listing of the store's sets, and no store under another name.
    // A store held under a name the Find scan does not know: an alias, or a parameter, field or property of type ResultStore.
    const otherName = (line: string) => [...line.matchAll(/\bResultStore\??\s+(\w+)\s*[,)=;{]/g)].some(match => !/^(?:\w*[sS]tore|Results)$/.test(match[1]))
    const around = (text: string) => text.split('\n').filter(line => !/^\s*\/\//.test(line) && (/\.Sets\(\)/.test(line) || otherName(line) || /\b(?:var|ResultStore\??)\s+\w+\s*=\s*(?:this\.)?\w*(?:[sS]tore|[rR]esults)\s*;/.test(line))).map(line => line.trim())
    expect(around('var held = store; var x = held.Find(a);')).toHaveLength(1)
    expect(around('var held = Results; var x = held.Find(a);')).toHaveLength(1)
    expect(around('ResultStore? lookup = store; var set = lookup.Find(id);')).toHaveLength(1)
    expect(around('internal sealed class PageTally(ResultStore owner) {')).toHaveLength(1)
    expect(around('private readonly ResultStore owner;')).toHaveLength(1)
    expect(around('public SqlService(ResultStore? store = null, bool hooks = false)')).toHaveLength(0)
    expect(around('var set = store.Sets().FirstOrDefault(s => s.ResultId == id);')).toHaveLength(1)
    // Readers inside Results/ (ResultJobs, ResultSearch) too; only the store's own files list its sets, and the packer,
    // which packs the pages a set holds (a windowed one holds none).
    const outsideStore = service.filter(file => !/\/Results\/ResultStore(?:\.[^/]+)?\.cs$/.test(file))
    expect(outsideStore.flatMap(file => around(readFileSync(file, 'utf8')).map(line => `${file.replace('backend/Varia.Backend/', '')}: ${line}`))).toEqual([
      'Results/ResultPacker.cs: var sets = store.Sets();',
      'Results/ResultPacker.cs: if (!store.Sets().Any(set => ForRoom(set, global, [query]))) return false;',
      'Results/ResultPacker.cs: var candidates = store.Sets()'
    ])
    // Nor through another accessor: the store hands out sets only by Find, Open (a new set) and Sets (listed above).
    const storeFiles = service.filter(file => /\/Results\/ResultStore(?:\.[^/]+)?\.cs$/.test(file))
    const handsOut = storeFiles.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:public|internal)\b[^=\n(]*\bResultSetBuffer\b[^=\n(]*?\s(\w+)\s*\(/gm)].map(match => match[1]))
    expect(handsOut.sort()).toEqual(['Find', 'Open', 'Sets'])
    const service2 = readFileSync('backend/Varia.Backend/SqlService.cs', 'utf8')
    expect(service2).toMatch(/if \(set\.Remote is \{ \} remote\) return args\.ViewId is null \? await ReadRemoteAsync\(args, set, remote, context\) : throw RemoteRefused\(\);/)
    expect(service2).toMatch(/if \(set\.Remote is \{ \} remote\) return args\.ViewId is null \? new ResultsRowBytesResult\(args\.FirstRow, remote\.RowBytes\(args\.FirstRow, args\.Count\), remote\.Rows, \[\]\) : throw RemoteRefused\(\);/)
    // Copy and Save lease the set first; the lease refuses a windowed one, before and after it is taken (a switch between
    // the check and the lease), and a copy the switch overtakes is refused rather than cut short.
    const jobs = readFileSync('backend/Varia.Backend/Results/ResultJobs.cs', 'utf8')
    expect(jobs).toMatch(/var set = store\.Find\(resultId\);\n\s*\/\/[^\n]*\n\s*if \(set is \{ IsRemote: true \}\) throw SqlService\.RemoteRefused\(\);/)
    expect(jobs).toMatch(/if \(set is not null && set\.TryLease\(\)\)\n\s*\{\n\s*\/\/[^\n]*\n\s*if \(!set\.IsRemote\) return set;\n\s*set\.ReleaseLease\(\);\n\s*throw SqlService\.RemoteRefused\(\);/)
    expect(jobs).toMatch(/if \(pages\.Count == 0\) \{ if \(set\.IsRemote\) throw SqlService\.RemoteRefused\(\); yield break; \}/)
    // A switch between a reader's check and its hold: the snapshot, a view and an operation's release token refuse it under
    // the locks Demote takes (BigQueryExecutionChecks.Residence.cs drives each).
    const buffer = readFileSync('backend/Varia.Backend/Results/ResultSetBuffer.cs', 'utf8')
    expect(buffer).toMatch(/lock \(gate\) return remote is null \? \[\.\. pages\] : throw SqlService\.RemoteRefused\(\);/)
    expect(buffer).toMatch(/lock \(gate\) return state == 2 \|\| remote is not null \? new CancellationToken\(true\)/)
    expect(readFileSync('backend/Varia.Backend/Results/ResultStore.cs', 'utf8')).toMatch(/if \(set\.IsRemote\)\n\s*\{\n\s*Return\(set\.Budget, charged\);\n\s*throw SqlService\.RemoteRefused\(\);/)
    // Demote marks the set windowed before it drops the views and snapshots, so one finished meanwhile is refused or dropped;
    // a snapshot (filter lists) refuses a windowed set, and no page cache is kept for one.
    const store = readFileSync('backend/Varia.Backend/Results/ResultStore.cs', 'utf8')
    const demote = store.slice(store.indexOf('public bool Demote('), store.indexOf('return true;', store.indexOf('public bool Demote(')))
    expect(demote.indexOf('set.Demote(remote, totalRows, bump)')).toBeGreaterThan(0)
    expect(demote.indexOf('set.Demote(remote, totalRows, bump)')).toBeLessThan(demote.indexOf('DropViewsLocked([set])'))
    expect(store).toMatch(/set\.IsRemote \? "REMOTE_RESULT"/)
    expect(store).toMatch(/"REMOTE_RESULT" => SqlService\.RemoteRefused\(\),/)
    expect(buffer).toMatch(/if \(gone \|\| remote is not null \|\| page\.Stored is not PackedPage/)
    // A search and an operation over a set's pages stop on a switch (its revision moved), even one already loaded back.
    expect(readFileSync('backend/Varia.Backend/Results/ResultSearch.cs', 'utf8')).toMatch(/set\.IsReleased \|\| set\.Revision != revision \|\|/)
    expect(service2).toMatch(/if \(set\.Revision != revision\) throw RemoteRefused\(\);/)
    expect(service2).toMatch(/sets\.Select\(\(set, i\) => set\.IsRemote \|\| set\.Revision != revisions\[i\]\)\.Any\(moved => moved\)/)
    // Only the residence code builds a block cache or switches a set, so every switch bumps the revision, sends
    // resultSet.residence and settles the budget there; the store's Demote is the one caller of the set's.
    const callers = (pattern: RegExp) => [...new Set(lines(new RegExp(String.raw`^(?!\s*\/\/).*(?:${pattern.source})`), []).filter(at => at.startsWith('backend/Varia.Backend/')).map(at => at.replace(/:\d+$/, '')))].sort()
    // The cache's constructor is private (a regex cannot see what a target-typed new( builds): it is built only through
    // RemoteResult.Create, by the residence code; inside RemoteResult.cs only Create returns one. A method group of Promote
    // or Demote counts as a call.
    const remoteSource = readFileSync('backend/Varia.Backend/Results/RemoteResult.cs', 'utf8')
    expect(remoteSource).toMatch(/\n\s*private RemoteResult\(ResultStore store,/)
    expect(remoteSource).not.toMatch(/\b(?:public|internal|protected)\s+RemoteResult\s*\(/)
    expect([...remoteSource.matchAll(/\bRemoteResult\s+(\w+)\s*\(/g)].map(match => match[1])).toEqual(['Create'])
    // Whatever another factory inside the file returned (RemoteResult?, object, a Func field), it would build one with new
    // and take a fetch delegate: the file has no new RemoteResult, Create's target-typed new is its only construction, and
    // RemoteFetch appears only as its declaration, the field, and Create's and the constructor's parameters.
    const remoteCode = remoteSource.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
    expect(remoteCode).not.toMatch(/\bnew\s+(?:[\w.]+\.)?RemoteResult\s*[({]/)
    expect(remoteCode.match(/\bnew\s*\(\s*store\b/g)).toHaveLength(1)
    expect(remoteCode).toMatch(/RemoteFetch fetch, object\? source = null\) => new\(store, resultId, wires, rows, capped, rowBytes, cacheLimit, connectionLane, fetch\) \{ Source = source \};/)
    expect(remoteCode.match(/\bRemoteFetch\b/g)).toHaveLength(4)
    const bypass = remoteCode.replace('    private RemoteResult(ResultStore store,', '    internal static object Make(ResultStore s, RemoteFetch f) => new RemoteResult(s, 0, [], 0, false, 1, 0, new(1), f);\n    private RemoteResult(ResultStore store,')
    expect(bypass.match(/\bRemoteFetch\b/g)).toHaveLength(5)
    expect(bypass).toMatch(/\bnew\s+(?:[\w.]+\.)?RemoteResult\s*[({]/)
    expect(callers(/\bRemoteResult\.Create\b/)).toEqual(['backend/Varia.Backend/SqlService.BigQueryResidence.cs'])
    expect(callers(/\.Promote\b/)).toEqual(['backend/Varia.Backend/SqlService.BigQueryResidence.cs'])
    expect(callers(/\bstore\.Demote\b/)).toEqual(['backend/Varia.Backend/SqlService.BigQueryResidence.cs'])
    expect(callers(/\.Demote\b/)).toEqual(['backend/Varia.Backend/Results/ResultStore.cs', 'backend/Varia.Backend/SqlService.BigQueryResidence.cs'])
    expect(readFileSync('backend/Varia.Backend/SqlService.BigQueryResidence.cs', 'utf8')).toMatch(/internal static ResultSetBuffer Stored\(ResultSetBuffer set\) => set\.IsRemote \? throw RemoteRefused\(\) : set;/)
  })
  it('packs only behind the store\'s switch, off unless a check or the backend process\'s hidden-result policy turns it on', () => {
    const store = readFileSync('backend/Varia.Backend/Results/ResultStore.cs', 'utf8')
    expect(store).toMatch(/internal static PagePacking DefaultPacking \{ get; set; \} = PagePacking\.Off;/)
    expect(lines(/DefaultPacking\s*=(?!=)/, ['backend/Varia.Backend.Tests/Program.cs']).filter(line => !line.startsWith('backend/Varia.Backend/Results/ResultStore.cs'))).toEqual([])
    // Only the service that runs the policy (ResultPacker) turns a product store on request, and only the backend process asks it to.
    const file = (line: string) => line.replace(/:\d+$/, '')
    const product = lines(/\.Packing\s*=(?!=)|Packing = PagePacking\.(OnRequest|EveryComplete)/, []).filter(line => line.startsWith('backend/Varia.Backend/'))
    expect(product.map(file)).toEqual(['backend/Varia.Backend/SqlService.cs'])
    const service = readFileSync('backend/Varia.Backend/SqlService.cs', 'utf8')
    expect(service).toMatch(/if \(packHidden\)\n\s*\{\n\s*if \(this\.store\.Packing == PagePacking\.Off\) this\.store\.Packing = PagePacking\.OnRequest;/)
    expect(lines(/packHidden: true/, []).filter(line => line.startsWith('backend/Varia.Backend/')).map(file)).toEqual(['backend/Varia.Backend/SqlService.cs'])
    expect(service).toMatch(/return new SqlService\(ResultStore\.FromSystem\(budget, limit\), hooks, publish, packHidden: true, bigQuery: BigQueryEnvironment\.FromEnvironment\(\)\);/)
    // Packing at seal likewise: only that service turns it on, beside the policy.
    expect(lines(/\.PackAtSeal\s*=(?!=)/, []).filter(line => line.startsWith('backend/Varia.Backend/')).map(file)).toEqual(['backend/Varia.Backend/SqlService.cs'])
    expect(service).toMatch(/if \(this\.store\.Packing == PagePacking\.Off\) this\.store\.Packing = PagePacking\.OnRequest;\n\s*this\.store\.PackAtSeal = true;/)
    expect(store).toMatch(/internal bool PackAtSeal \{ get; set; \}\n/)
  })
})
