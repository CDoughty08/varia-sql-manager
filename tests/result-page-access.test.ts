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
    const service = sources.filter(file => /^backend\/Varia\.Backend\/SqlService[^/]*\.cs$/.test(file))
    const unguarded = service.flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, index) => [file, index + 1, line] as const))
      .filter(([, , line]) => /\bstore\.Find\(/.test(line) && !/\bStored\(store\.Find\(/.test(line))
      .map(([file, , line]) => `${file.replace('backend/Varia.Backend/', '')}: ${line.trim()}`)
    expect(unguarded.sort()).toEqual([
      // Visibility only asks whether the result exists.
      'SqlService.cs: visibility = new ResultVisibility(id => this.store.Find(id) is not null);',
      // results.read and results.rowBytes route a windowed result to its block cache (ReadRemoteAsync, RemoteResult.RowBytes).
      'SqlService.cs: var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);',
      'SqlService.cs: var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);',
      // A comparison being replaced is a diff the backend built in memory, never windowed.
      'SqlService.cs: var replaced = store.Find(replacedId) ?? throw Unavailable(replacedId);',
      // Load into memory is the one request that wants the windowed result.
      'SqlService.BigQueryResidence.cs: var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);'
    ].sort())
    const service2 = readFileSync('backend/Varia.Backend/SqlService.cs', 'utf8')
    expect(service2).toMatch(/if \(set\.Remote is \{ \} remote\) return args\.ViewId is null \? await ReadRemoteAsync\(args, set, remote, context\) : throw RemoteRefused\(\);/)
    expect(service2).toMatch(/if \(set\.Remote is \{ \} remote\) return args\.ViewId is null \? new ResultsRowBytesResult\(args\.FirstRow, remote\.RowBytes\(args\.FirstRow, args\.Count\), remote\.Rows, \[\]\) : throw RemoteRefused\(\);/)
    // Copy and Save lease the set first; the lease refuses a windowed one.
    expect(readFileSync('backend/Varia.Backend/Results/ResultJobs.cs', 'utf8')).toMatch(/var set = store\.Find\(resultId\);\n\s*\/\/[^\n]*\n\s*if \(set is \{ IsRemote: true \}\) throw SqlService\.RemoteRefused\(\);/)
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
