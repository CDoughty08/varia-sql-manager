import { describe, expect, it } from 'vitest'
import { MetricRing, ringBytesPerSample, ringGap, ringMaxCapacity, ringReset } from '../src/renderer/src/live/ring'

const times = (ring: MetricRing) => Array.from({ length: ring.length }, (_, index) => ring.time(index))
const column = (ring: MetricRing, series: number) => Array.from({ length: ring.length }, (_, index) => ring.value(index, series))

describe('metric ring', () => {
  it('keeps the newest samples in time order once it wraps', () => {
    const ring = new MetricRing(4, 2)
    for (let at = 1; at <= 6; at++) ring.push(at * 1000, [at, at * 10])
    expect(ring.length).toBe(4)
    expect(times(ring)).toEqual([3000, 4000, 5000, 6000])
    expect(column(ring, 0)).toEqual([3, 4, 5, 6])
    expect(column(ring, 1)).toEqual([30, 40, 50, 60])
    expect(ring.lastTime).toBe(6000)
    expect(ring.revision).toBe(6)
  })

  it('never lets time run backwards', () => {
    const ring = new MetricRing(8, 1)
    ring.push(5000, [1])
    ring.push(4000, [2])
    ring.push(Number.NaN, [3])
    ring.push(6000, [4])
    expect(times(ring)).toEqual([5000, 5000, 5000, 6000])
  })

  it('stores missing values as NaN and keeps only the gap and reset flags', () => {
    const ring = new MetricRing(4, 3)
    ring.push(1000, [null, Number.POSITIVE_INFINITY, 2], ringGap)
    ring.push(2000, [1], ringReset | ringGap | 0x80)
    expect(column(ring, 0)).toEqual([Number.NaN, 1])
    expect(column(ring, 1)).toEqual([Number.NaN, Number.NaN])
    expect(column(ring, 2)).toEqual([2, Number.NaN])
    expect([ring.flags(0), ring.flags(1)]).toEqual([ringGap, ringGap | ringReset])
  })

  it('finds samples by time and ranges by binary search', () => {
    const ring = new MetricRing(5, 1)
    for (let at = 1; at <= 7; at++) ring.push(at * 1000, [at])
    // Kept: 3000 … 7000.
    expect(ring.indexAt(0)).toBe(0)
    expect(ring.indexAt(3000)).toBe(0)
    expect(ring.indexAt(3500)).toBe(1)
    expect(ring.indexAt(7000)).toBe(4)
    expect(ring.indexAt(9000)).toBe(5)
    expect(ring.range(4000, 6000)).toEqual({ first: 1, count: 3 })
    expect(ring.range(4500, 4600)).toEqual({ first: 2, count: 0 })
    expect(ring.range(6000, 4000)).toEqual({ first: 3, count: 0 })
    expect(ring.range(0, 100_000)).toEqual({ first: 0, count: 5 })
  })

  it('reports each series\' extremes, ignoring missing values', () => {
    const ring = new MetricRing(8, 2)
    ring.push(1, [5, null])
    ring.push(2, [-3, null])
    ring.push(3, [9, null])
    expect(ring.minMax(0, 0, 3)).toEqual([-3, 9])
    expect(ring.minMax(0, 1, 1)).toEqual([-3, -3])
    expect(ring.minMax(1, 0, 3)).toEqual([Number.NaN, Number.NaN])
    expect(ring.minMax(0, 2, 100)).toEqual([9, 9])
  })

  it('keeps the newest samples, in order, when its capacity changes', () => {
    const ring = new MetricRing(6, 1)
    for (let at = 1; at <= 8; at++) ring.push(at, [at], at === 6 ? ringGap : 0)
    const revision = ring.revision
    ring.resize(3)
    expect(ring.capacity).toBe(3)
    expect(times(ring)).toEqual([6, 7, 8])
    expect([ring.flags(0), ring.flags(1)]).toEqual([ringGap, 0])
    expect(ring.revision).toBeGreaterThan(revision)
    ring.push(9, [9])
    expect(column(ring, 0)).toEqual([7, 8, 9])
    ring.resize(10)
    expect(times(ring)).toEqual([7, 8, 9])
    ring.push(10, [10])
    expect(column(ring, 0)).toEqual([7, 8, 9, 10])
  })

  it('bounds its memory by construction', () => {
    expect(new MetricRing(1_000_000, 64).capacity).toBe(ringMaxCapacity)
    expect(new MetricRing(0, 1).capacity).toBe(2)
    const ring = new MetricRing(ringMaxCapacity, 12)
    expect(ring.bytes).toBe(ringMaxCapacity * ringBytesPerSample(12))
    expect(ring.bytes).toBeLessThan(1024 * 1024)
    for (let at = 0; at < 3 * ringMaxCapacity; at++) ring.push(at, [at])
    expect(ring.length).toBe(ringMaxCapacity)
    expect(() => new MetricRing(10, 0)).toThrow(RangeError)
    expect(() => new MetricRing(10, 65)).toThrow(RangeError)
  })
})
