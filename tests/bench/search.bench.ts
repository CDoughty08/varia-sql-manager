import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { record, type Metric } from './harness'

// Search Objects' in-memory search (backend/Varia.Backend/Search/ObjectIndex.cs) over a synthetic million-object index, timed
// inside the .NET test program (backend/Varia.Backend.Tests/SearchBench.cs): the index lives only in a connection's backend, so
// the node pipeline cannot reach it without a server. `dotnet run` builds the test program first when it is out of date.
it('measures a one-letter object search over a million objects', () => {
  const output = execFileSync('dotnet', ['run', '--project', 'backend/Varia.Backend.Tests/Varia.Backend.Tests.csproj', '--configuration', 'Release', '--', '--search-bench'],
    { encoding: 'utf8', timeout: 280_000, maxBuffer: 16 * 1024 * 1024 })
  const measured = new Map(output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Metric).map(metric => [metric.id, metric]))
  const time = measured.get('node.search.firstLetterP95Ms'), allocated = measured.get('node.search.firstLetterAllocatedMb')
  expect(time && allocated).toBeTruthy()
  record(
    { id: 'node.search.firstLetterP95Ms', value: time!.value, unit: 'ms', detail: time!.detail },
    { id: 'node.search.firstLetterAllocatedMb', value: allocated!.value, unit: 'MB', detail: allocated!.detail }
  )
})
