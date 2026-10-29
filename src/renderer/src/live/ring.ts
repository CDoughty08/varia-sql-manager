// A live view's history of one metrics probe (docs/ipc.md, Live subscriptions): a fixed-size ring of samples in typed
// arrays, newest overwriting oldest, so memory is bounded by construction whatever runs for how long. Charts read it
// directly (no copies); the backend keeps no history, so it survives a backend restart and a resubscription.

/** A sample follows a gap (the first one, after a pause or a resubscription, a reset, or missed slots): charts break the
 *  line before it. */
export const ringGap = 1
/** The server's counters restarted before this sample (a SQL Server restart): rates start again. */
export const ringReset = 2
/** The most samples one ring holds: two hours at 1 s. */
export const ringMaxCapacity = 7200

/** Bytes one sample takes: its time, its flags, and a value per series. */
export const ringBytesPerSample = (series: number): number => 8 + 1 + 8 * series

export class MetricRing {
  readonly series: number
  private capacityValue: number
  private timesValue: Float64Array
  private valuesValue: Float64Array
  private flagsValue: Uint8Array
  /** The slot the next sample goes in. */
  private headValue = 0
  private lengthValue = 0
  private revisionValue = 0

  constructor(capacity: number, series: number) {
    if (!Number.isInteger(series) || series < 1 || series > 64) throw new RangeError('A ring holds 1 to 64 series.')
    this.series = series
    this.capacityValue = MetricRing.clampCapacity(capacity)
    this.timesValue = new Float64Array(this.capacityValue)
    this.valuesValue = new Float64Array(this.capacityValue * series)
    this.flagsValue = new Uint8Array(this.capacityValue)
  }

  static clampCapacity(capacity: number): number { return Math.max(2, Math.min(ringMaxCapacity, Math.floor(Number.isFinite(capacity) ? capacity : 2))) }

  get capacity(): number { return this.capacityValue }
  get length(): number { return this.lengthValue }
  /** Bumps with every push and resize, so a chart redraws only when it changed. */
  get revision(): number { return this.revisionValue }
  get bytes(): number { return this.capacityValue * ringBytesPerSample(this.series) }
  /** The newest sample's time, or undefined while empty. */
  get lastTime(): number | undefined { return this.lengthValue === 0 ? undefined : this.timesValue[this.slot(this.lengthValue - 1)] }

  /** Appends a sample: `time` in Unix ms, never before the previous one (an earlier time is moved up to it), and one
   *  value per series, null or a non-finite number meaning none. O(series). */
  push(time: number, values: readonly (number | null)[], flags = 0): void {
    const last = this.lastTime
    const at = this.headValue
    this.timesValue[at] = last !== undefined && !(time >= last) ? last : time
    this.flagsValue[at] = flags & (ringGap | ringReset)
    const base = at * this.series
    for (let series = 0; series < this.series; series++) {
      const value = values[series]
      this.valuesValue[base + series] = typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
    }
    this.headValue = (at + 1) % this.capacityValue
    if (this.lengthValue < this.capacityValue) this.lengthValue++
    this.revisionValue++
  }

  /** The i-th sample in time order, 0 the oldest kept. */
  time(index: number): number { return this.timesValue[this.slot(index)] }
  value(index: number, series: number): number { return this.valuesValue[this.slot(index) * this.series + series] }
  flags(index: number): number { return this.flagsValue[this.slot(index)] }

  /** The first sample at or after `time` (length when none is), by binary search: O(log n). */
  indexAt(time: number): number { return this.search(time, false) }

  /** The samples whose times fall in [from, to]. */
  range(from: number, to: number): { first: number; count: number } {
    const first = this.indexAt(from)
    const end = to < from ? first : this.search(to, true)
    return { first, count: Math.max(0, end - first) }
  }

  /** The smallest and largest value of one series over `count` samples from `first`, ignoring missing ones; NaN for
   *  both when there are none. O(count). */
  minMax(series: number, first: number, count: number): [number, number] {
    let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY
    const end = Math.min(this.lengthValue, first + count)
    for (let index = Math.max(0, first); index < end; index++) {
      const value = this.value(index, series)
      if (value < min) min = value
      if (value > max) max = value
    }
    return min > max ? [Number.NaN, Number.NaN] : [min, max]
  }

  /** A new capacity (an interval or the history setting changed, or memory is short): the newest samples that fit are
   *  kept, in order. */
  resize(capacity: number): void {
    const next = MetricRing.clampCapacity(capacity)
    if (next === this.capacityValue) return
    const keep = Math.min(this.lengthValue, next), skip = this.lengthValue - keep
    const times = new Float64Array(next), values = new Float64Array(next * this.series), flags = new Uint8Array(next)
    for (let index = 0; index < keep; index++) {
      const from = this.slot(skip + index)
      times[index] = this.timesValue[from]
      flags[index] = this.flagsValue[from]
      values.set(this.valuesValue.subarray(from * this.series, (from + 1) * this.series), index * this.series)
    }
    this.timesValue = times
    this.valuesValue = values
    this.flagsValue = flags
    this.capacityValue = next
    this.lengthValue = keep
    this.headValue = keep % next
    this.revisionValue++
  }

  /** The first sample after `time` (`after`), or at or after it. */
  private search(time: number, after: boolean): number {
    let low = 0, high = this.lengthValue
    while (low < high) {
      const middle = (low + high) >>> 1, at = this.time(middle)
      if (at < time || (after && at === time)) low = middle + 1
      else high = middle
    }
    return low
  }

  private slot(index: number): number {
    return (this.headValue - this.lengthValue + index + this.capacityValue) % this.capacityValue
  }
}

/** What a chart reads from a ring: a MetricRing, or a view of one (scaledRing). */
export type RingReader = Pick<MetricRing, 'revision' | 'capacity' | 'series' | 'length' | 'lastTime' | 'time' | 'value' | 'flags' | 'indexAt' | 'range' | 'minMax'>

const scaledViews = new WeakMap<MetricRing, Map<number, RingReader>>()
/**
 * A ring whose values read multiplied by `factor` (positive), for a series sent in one unit and shown in another: wait
 * milliseconds per second as waiting tasks (× 0.001). Times, flags and revisions are the ring's own, so a chart redraws as
 * the ring changes. One view per ring and factor, so a chart sees the same object every frame.
 */
export function scaledRing(ring: MetricRing, factor: number): RingReader {
  if (factor === 1 || !(factor > 0) || !Number.isFinite(factor)) return ring
  let views = scaledViews.get(ring)
  if (!views) { views = new Map(); scaledViews.set(ring, views) }
  let view = views.get(factor)
  if (!view) {
    view = {
      get revision() { return ring.revision },
      get capacity() { return ring.capacity },
      get series() { return ring.series },
      get length() { return ring.length },
      get lastTime() { return ring.lastTime },
      time: index => ring.time(index),
      value: (index, series) => ring.value(index, series) * factor,
      flags: index => ring.flags(index),
      indexAt: time => ring.indexAt(time),
      range: (from, to) => ring.range(from, to),
      minMax: (series, first, count) => { const [min, max] = ring.minMax(series, first, count); return [min * factor, max * factor] }
    }
    views.set(factor, view)
  }
  return view
}
