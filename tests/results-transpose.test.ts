import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backendDescriptorSchema } from '../src/shared/ipc/descriptors'
import { backendMethods, isBackendMethod } from '../src/shared/ipc/methods'
import { portRequestSchema } from '../src/shared/ipc/port-messages'
import { limits } from '../src/shared/ipc/wire/protocol'
import { turnableKinds } from '../src/renderer/src/results/ResultsService'

// Transposed is how a grid is drawn (tests/results-orientation.test.ts, tests/grid-orientation.test.ts), never a stored
// result: results.transpose, its port request, the `transpose` result kind and TransposeService are gone, and these pin
// that nothing brings one of them back. The backend's side is HostChecks' retired methods.
describe('the stored transpose is gone', () => {
  const descriptor = (kind: string) => ({
    resultId: 5, index: 0, batchNumber: 1, iteration: 1, kind, columns: [{ name: 'Column', dataType: 'nvarchar(max)', wire: 'text', nullable: true }],
    rowsRead: 1, rowsStored: 1, rowsAvailable: 1, bytesStored: 10, truncatedCells: 0, state: 'complete', incomplete: false
  })

  it('is no backend method, in main or in the backend', () => {
    expect(isBackendMethod('results.transpose')).toBe(false)
    expect(backendMethods.filter(method => /transpos/i.test(method))).toEqual([])
    const service = readFileSync(join('backend', 'Varia.Backend', 'SqlService.cs'), 'utf8')
    expect(service).toContain('"results.pivot"')
    expect(service).not.toContain('results.transpose')
    expect(existsSync(join('backend', 'Varia.Backend', 'Results', 'ResultTranspose.cs'))).toBe(false)
  })

  it('is no request of the results port, and no kind a result can have', () => {
    // The request the removed member took at its smallest, and its fullest: a restored member would accept both.
    const ask = (body: object) => portRequestSchema.safeParse({ rid: 1, generation: 1, resultId: 2, ...body }).success
    expect(ask({ t: 'pivot', rows: [], values: [{ aggregate: 'count' }] })).toBe(true)
    expect([ask({ t: 'transpose' }), ask({ t: 'transpose', viewId: 3, rows: [[0, 1]], headerColumn: 0 })]).toEqual([false, false])
    expect(['rows', 'executionPlan', 'diff', 'pivot', 'transpose'].map(kind => backendDescriptorSchema.safeParse(descriptor(kind)).success)).toEqual([true, true, true, true, false])
    expect([...turnableKinds].sort()).toEqual(['pivot', 'rows'])
  })

  it("is no request of a result's handle or the results worker, and leaves only the rows a transposed grid draws as its limit", () => {
    // The real client's handle is checked in tests/result-client.test.ts; here, that no source on the way names one.
    const results = join('src', 'renderer', 'src', 'results')
    for (const file of [join(results, 'ResultClient.ts'), join(results, 'worker-protocol.ts'), join(results, 'worker-core.ts'), join('src', 'main', 'backend', 'results-port.ts'), join('src', 'shared', 'ipc', 'port-messages.ts'), join('src', 'shared', 'ipc', 'methods.ts')])
      expect(readFileSync(file, 'utf8').split('\n').filter(line => /transpos/i.test(line.replaceAll('limits.transpose.maxRows', ''))), file).toEqual([])
    expect(limits.transpose).toEqual({ maxRows: limits.page.maxColumns - 1 })
    expect(existsSync(join('src', 'renderer', 'src', 'results', 'TransposeService.ts'))).toBe(false)
  })
})
