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
  it('stores pages only through ResultSetBuffer, and builds set-less pages only for a view read', () => {
    expect(lines(/new StoredPage\(/, [accessor, 'backend/Varia.Backend/Results/ResultViews.cs'])).toEqual([])
    const views = readFileSync('backend/Varia.Backend/Results/ResultViews.cs', 'utf8')
    expect([...views.matchAll(/new StoredPage\(([^;]*)\);/g)].map(match => match[1].split(',').length)).toEqual([4, 4])
  })
  it('packs only behind the store\'s switch, off unless a check turns it on', () => {
    const store = readFileSync('backend/Varia.Backend/Results/ResultStore.cs', 'utf8')
    expect(store).toMatch(/internal static PagePacking DefaultPacking \{ get; set; \} = PagePacking\.Off;/)
    expect(lines(/DefaultPacking\s*=(?!=)/, ['backend/Varia.Backend.Tests/Program.cs']).filter(line => !line.startsWith('backend/Varia.Backend/Results/ResultStore.cs'))).toEqual([])
    expect(lines(/\.Packing\s*=(?!=)|Packing = PagePacking\.(OnRequest|EveryComplete)/, []).filter(line => line.startsWith('backend/Varia.Backend/'))).toEqual([])
  })
})
