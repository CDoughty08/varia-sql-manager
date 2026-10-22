import { describe, expect, it } from 'vitest'
import type { LiveProbeSnapshot, LiveSnapshot } from '../src/renderer/src/live/LiveService'
import { formatInterval, formatUpdated, liveIndicator } from '../src/renderer/src/live/status'

const now = 1_800_000_000_000
const probe = (patch: Partial<LiveProbeSnapshot> = {}): LiveProbeSnapshot => ({ state: 'fresh', intervalMs: 2000, effectiveIntervalMs: 2000, lastSampleAt: now - 1500, ...patch })
const snapshot = (patch: Partial<LiveSnapshot> = {}, probes: Record<string, LiveProbeSnapshot> = { a: probe() }): LiveSnapshot => ({ status: 'live', probes, connectionId: 'c', ...patch })

describe('live indicator', () => {
  it('formats intervals and ages as the pills say them', () => {
    expect([500, 1000, 2000, 2500, 30_000, 60_000, 90_000, 300_000, 3_600_000, 5_400_000].map(formatInterval)).toEqual(['500 ms', '1 s', '2 s', '2.5 s', '30 s', '1 min', '90 s', '5 min', '1 h', '1 h 30 min'])
    expect([now - 400, now - 1000, now - 12_900, now - 61_000, now - 3 * 3_600_000, now + 5000].map(at => formatUpdated(at, now))).toEqual(['Updated just now', 'Updated 1 s ago', 'Updated 12 s ago', 'Updated 1 min ago', 'Updated 3 h ago', 'Updated just now'])
  })

  it('says Live with the shortest running interval, and when it last updated', () => {
    expect(liveIndicator(snapshot({}, { a: probe(), b: probe({ intervalMs: 5000, effectiveIntervalMs: 5000, lastSampleAt: now - 400 }), c: probe({ state: 'paused', intervalMs: 1000, effectiveIntervalMs: 1000 }) }), now))
      .toEqual({ tone: 'live', label: 'Live · every 2 s', detail: 'Updated just now' })
    expect(liveIndicator(snapshot({}, { a: probe({ lastSampleAt: undefined }) }), now)).toEqual({ tone: 'live', label: 'Live · every 2 s' })
    // Only the probes a view shows count.
    expect(liveIndicator(snapshot({}, { a: probe(), b: probe({ state: 'stale' }) }), now, ['a' as never]).tone).toBe('live')
  })

  it('says Slowed when the backend backed off, and stale with the reason when a probe fails or falls behind', () => {
    expect(liveIndicator(snapshot({}, { a: probe({ effectiveIntervalMs: 4000 }) }), now)).toEqual({ tone: 'slowed', label: 'Slowed to 4 s', detail: 'Updated 1 s ago' })
    expect(liveIndicator(snapshot({}, { a: probe({ state: 'stale', lastSampleAt: now - 12_000 }) }), now)).toEqual({ tone: 'stale', label: 'Live', detail: 'Updated 12 s ago' })
    const blocked = probe({ state: 'failing', error: { probe: 'debug.synthetic.table', code: 'BLOCKED', message: 'Blocked by a lock, retrying in 4 s.', retryInMs: 4000, terminal: false } })
    expect(liveIndicator(snapshot({}, { a: blocked }), now)).toEqual({ tone: 'stale', label: 'Live', detail: 'Updated 1 s ago · Blocked by a lock, retrying in 4 s.' })
    expect(liveIndicator(snapshot({}, { a: probe({ state: 'stale', lastSampleAt: undefined }) }), now).detail).toBe('Waiting for the first sample')
  })

  it('says why a view is not live', () => {
    expect(liveIndicator(snapshot({ status: 'connecting' }, { a: probe({ lastSampleAt: undefined }) }), now)).toEqual({ tone: 'connecting', label: 'Connecting' })
    expect(liveIndicator(snapshot({ status: 'paused', pausedBy: 'user' }), now)).toEqual({ tone: 'paused', label: 'Paused', detail: 'Updated 1 s ago' })
    expect(liveIndicator(snapshot({ status: 'paused', pausedBy: 'hidden' }), now).label).toBe('Paused while hidden')
    expect(liveIndicator(snapshot({ status: 'dormant', pausedBy: 'hidden' }), now).label).toBe('Paused while hidden')
    expect(liveIndicator(snapshot({ hiddenMode: 'statusOnly' }, { a: probe({ effectiveIntervalMs: 30_000 }), t: probe({ state: 'paused' }) }), now)).toEqual({ tone: 'paused', label: 'Hidden · status every 30 s', detail: 'Updated 1 s ago' })
    expect(liveIndicator(snapshot({ status: 'lost', error: { code: 'BACKEND_LOST', message: 'The SQL backend restarted.' } }), now)).toEqual({ tone: 'lost', label: 'Connection lost', detail: 'The SQL backend restarted.' })
    expect(liveIndicator(snapshot({ status: 'ended', ended: { ended: 'disconnected', ticks: 1, elapsedMs: 1 } }), now)).toEqual({ tone: 'ended', label: 'Disconnected', detail: 'Updated 1 s ago' })
    expect(liveIndicator(snapshot({ status: 'ended', ended: { ended: 'sourceEnded', ticks: 1, elapsedMs: 1 } }), now).label).toBe('Finished')
    expect(liveIndicator(snapshot({ status: 'ended', error: { code: 'TOO_MANY_REQUESTS', message: 'Too many live views are open in this window. Close one and retry.' } }, { a: probe({ lastSampleAt: undefined }) }), now))
      .toEqual({ tone: 'ended', label: 'Stopped', detail: 'Too many live views are open in this window. Close one and retry.' })
  })
})
