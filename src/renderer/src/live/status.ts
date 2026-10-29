// What a live view's pill and stale badge say (the states kit draws them): from a LiveHandle's snapshot and the time, so
// "Updated 12 s ago" moves on with a ticker while nothing new arrives. It never claims more than the snapshot shows.
import type { LiveProbeId } from '../../../shared/live/catalog'
import type { LiveStatus as KitLiveStatus } from '../kit/format'
import type { LiveProbeSnapshot, LiveSnapshot } from './LiveService'

export type LiveTone = 'connecting' | 'live' | 'slowed' | 'stale' | 'paused' | 'lost' | 'ended'
export interface LiveIndicator {
  readonly tone: LiveTone
  /** The pill: "Live · every 2 s", "Slowed to 4 s", "Paused", "Paused while hidden", "Connection lost", … */
  readonly label: string
  /** The badge beside it: "Updated 12 s ago", or why the view stopped. */
  readonly detail?: string
}

/** "2 s", "500 ms", "1 min", "1 h 30 min". */
export function formatInterval(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000 || ms % 60_000 !== 0) return `${Number((ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1))} s`
  const minutes = ms / 60_000
  if (minutes < 60) return `${minutes} min`
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** "Updated just now", "Updated 12 s ago", "Updated 3 min ago", "Updated 2 h ago". */
export function formatUpdated(lastSampleAt: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - lastSampleAt) / 1000)
  if (seconds < 1) return 'Updated just now'
  if (seconds < 60) return `Updated ${seconds} s ago`
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)} min ago`
  return `Updated ${Math.floor(seconds / 3600)} h ago`
}

/** The indicator for the probes a view shows (all of them by default). */
export function liveIndicator(snapshot: LiveSnapshot, now: number, shown?: readonly LiveProbeId[]): LiveIndicator {
  const probes: LiveProbeSnapshot[] = shown ? shown.flatMap(probe => snapshot.probes[probe] ? [snapshot.probes[probe]] : []) : Object.values(snapshot.probes)
  const newest = probes.reduce<number | undefined>((latest, probe) => probe.lastSampleAt === undefined ? latest : Math.max(latest ?? 0, probe.lastSampleAt), undefined)
  const updated = newest === undefined ? undefined : formatUpdated(newest, now)
  const reason = snapshot.error?.message
  // A running view's error is an update the backend refused (it shows what still runs): the badge says so.
  const noted = (detail?: string) => { const text = [detail, reason].filter(Boolean).join(' · '); return text ? { detail: text } : {} }
  switch (snapshot.status) {
    case 'connecting': return { tone: 'connecting', label: 'Connecting', ...updated ? { detail: updated } : {} }
    case 'paused': return { tone: 'paused', label: snapshot.pausedBy === 'hidden' ? 'Paused while hidden' : 'Paused', ...noted(updated) }
    case 'dormant': return { tone: 'paused', label: 'Paused while hidden', ...updated ? { detail: updated } : {} }
    case 'lost': return { tone: 'lost', label: 'Connection lost', detail: reason ?? updated ?? 'The SQL backend stopped.' }
    case 'ended': {
      const ended = snapshot.ended?.ended
      const label = ended === 'disconnected' ? 'Disconnected' : ended === 'sourceEnded' ? 'Finished' : 'Stopped'
      const detail = reason ?? updated
      return { tone: 'ended', label, ...detail ? { detail } : {} }
    }
    case 'live': break
  }
  const running = probes.filter(probe => probe.state !== 'paused' && probe.state !== 'unavailable')
  if (snapshot.hiddenMode === 'statusOnly') {
    const every = running.length ? Math.min(...running.map(probe => probe.effectiveIntervalMs)) : undefined
    return { tone: 'paused', label: every === undefined ? 'Paused while hidden' : `Hidden · status every ${formatInterval(every)}`, ...noted(updated) }
  }
  const slowed = running.filter(probe => probe.effectiveIntervalMs > probe.intervalMs)
  if (slowed.length > 0) return { tone: 'slowed', label: `Slowed to ${formatInterval(Math.max(...slowed.map(probe => probe.effectiveIntervalMs)))}`, ...noted(updated) }
  const failing = running.find(probe => probe.state === 'failing' || probe.state === 'stale')
  if (failing) return { tone: 'stale', label: 'Live', detail: [updated, failing.error?.message, reason].filter(Boolean).join(' · ') || 'Waiting for the first sample' }
  const every = running.length ? Math.min(...running.map(probe => probe.intervalMs)) : undefined
  return { tone: 'live', label: every === undefined ? 'Live' : `Live · every ${formatInterval(every)}`, ...noted(updated) }
}

/**
 * The states kit's pill for a view (kit/LivePill): the view's status, `slowed` while the backend runs a shown probe
 * slower than asked (the load guard or a back-off), the interval of the shown probes that run, who paused it and how it
 * ended. Paused and unavailable probes are left out, so a monitor whose panes are hidden still reads by its tiles' pace;
 * a running view none of whose probes can run (every one unavailable) has no pill, since nothing is live.
 */
export function pillStatus(snapshot: LiveSnapshot, shown?: readonly LiveProbeId[]): KitLiveStatus | undefined {
  const probes: LiveProbeSnapshot[] = shown ? shown.flatMap(probe => snapshot.probes[probe] ? [snapshot.probes[probe]] : []) : Object.values(snapshot.probes)
  const running = probes.filter(probe => probe.state !== 'paused' && probe.state !== 'unavailable')
  const pace = running.length ? running : probes
  const intervalMs = pace.length ? Math.min(...pace.map(probe => probe.intervalMs)) : 0
  const slowed = running.filter(probe => probe.effectiveIntervalMs > probe.intervalMs)
  switch (snapshot.status) {
    case 'connecting': return { state: 'connecting', intervalMs }
    case 'paused': return { state: 'paused', intervalMs, ...snapshot.pausedBy ? { pausedBy: snapshot.pausedBy } : {} }
    case 'dormant': return { state: 'dormant', intervalMs }
    case 'lost': return { state: 'lost', intervalMs }
    case 'ended': return { state: 'ended', intervalMs, ...snapshot.ended ? { ended: snapshot.ended.ended } : {} }
    case 'live': break
  }
  if (!running.length) return undefined
  if (slowed.length) {
    const worst = slowed.reduce((most, probe) => probe.effectiveIntervalMs / probe.intervalMs > most.effectiveIntervalMs / most.intervalMs ? probe : most)
    return { state: 'slowed', intervalMs: worst.intervalMs, effectiveMs: worst.effectiveIntervalMs }
  }
  return { state: 'live', intervalMs }
}

/** The newest sample of the shown probes that run (the "Updated 3 s ago" time), and since when one of them has been out
 *  of date, for the states kit's StaleBadge. A retry time is left out: the snapshot does not say when the error came, so
 *  a countdown from it would not move. */
export function freshness(snapshot: LiveSnapshot, now: number, shown?: readonly LiveProbeId[]): { readonly updatedAt?: number; readonly stale?: { readonly since: number } } {
  const probes = (shown ? shown.flatMap(probe => snapshot.probes[probe] ? [snapshot.probes[probe]] : []) : Object.values(snapshot.probes)).filter(probe => probe.state !== 'paused' && probe.state !== 'unavailable')
  const times = probes.flatMap(probe => probe.lastSampleAt === undefined ? [] : [probe.lastSampleAt])
  const updatedAt = times.length ? Math.max(...times) : undefined
  // A view that is not running reads its probes paused, so only a running one can be late.
  const late = probes.filter(probe => probe.state === 'stale' || probe.state === 'failing')
  if (!late.length) return updatedAt === undefined ? {} : { updatedAt }
  return { ...updatedAt === undefined ? {} : { updatedAt }, stale: { since: Math.min(...late.map(probe => probe.lastSampleAt ?? now)) } }
}
