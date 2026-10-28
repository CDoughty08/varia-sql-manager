import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { liveSources } from '../src/shared/live/catalog'
import { liveTestHooks } from '../src/renderer/src/live/test-hooks'
import type { LiveService } from '../src/renderer/src/live/LiveService'
import type { DocumentService } from '../src/renderer/src/services/documents'
import type { PaneService } from '../src/renderer/src/services/panes'

// scripts/live-smoke.mjs opens its views through window.__variaLive on the fake backend (tests/fixtures/backend.mjs,
// workbench mode), which implements only some of debug.synthetic's probes and refuses a subscription naming any other.
// When the catalogue gained the grid, log and wide probes, a default of every catalogued probe ended each smoke view at
// once with INVALID_PARAMS.

/** The probes the fake backend's workbench live.subscribe accepts, read from the fixture (it runs as a process). */
function fakeBackendProbes(): string[] {
  const text = readFileSync('tests/fixtures/backend.mjs', 'utf8')
  const declared = /^const syntheticProbes = (\[[^\]]*\])$/m.exec(text)
  expect(declared, 'tests/fixtures/backend.mjs declares syntheticProbes').not.toBeNull()
  return JSON.parse(declared![1].replaceAll("'", '"')) as string[]
}

function hooks() {
  const open = vi.fn((_spec: Parameters<LiveService['open']>[0]) => ({ id: 'view-' + open.mock.calls.length }))
  const live = { open } as unknown as LiveService
  const documents = { getSnapshot: () => ({ activeId: 'tab-1' }), get: () => ({ connectionId: 'connection-1' }), subscribe: () => () => {} } as unknown as DocumentService
  const panes = { getSnapshot: () => ({ editor: true }), subscribe: () => () => {} } as unknown as PaneService
  return { open, hooks: liveTestHooks(live, documents, panes) }
}

describe('window.__variaLive', () => {
  it('opens a synthetic view on only the probes the fake backend implements when the test names none', () => {
    const { open, hooks: live } = hooks()
    live.subscribeSynthetic({ tickMs: 50, rows: 5 })
    const spec = open.mock.calls[0][0]
    expect(spec).toMatchObject({ connectionId: 'connection-1', source: 'debug.synthetic', args: { tickMs: 50, rows: 5 } })
    const probes = spec.probes.map(probe => probe.probe)
    expect(probes).toEqual(fakeBackendProbes())
    // Every default probe is the source's own, so the real backend opens the same view.
    expect(probes.every(probe => (liveSources['debug.synthetic'].probes as readonly string[]).includes(probe))).toBe(true)
  })

  it('opens the probes a test names', () => {
    const { open, hooks: live } = hooks()
    live.subscribeSynthetic({ probes: ['debug.synthetic.grid'], intervalMs: 250 })
    expect(open.mock.calls[0][0].probes).toEqual([{ probe: 'debug.synthetic.grid', intervalMs: 250 }])
  })
})
