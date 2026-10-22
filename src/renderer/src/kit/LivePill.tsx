import { useTicker } from '../core/useTicker'
import { liveLabel, staleLabel, updatedLabel, type LiveStatus } from './format'

/**
 * What a live view is doing: a pulsing dot and "Live · every 2 s", a steady dot and "Live · slowed to 4 s" when the
 * server asked for longer, or a pause glyph and "Paused". The state comes from the live layer; this only draws it.
 */
export function LivePill(status: LiveStatus) {
  const text = liveLabel(status)
  return <span className="live-pill" data-state={status.state}>
    {status.state === 'paused' ? <span className="codicon codicon-debug-pause" aria-hidden="true" /> : <span className="live-dot" aria-hidden="true" />}
    <span>{text}</span>
  </span>
}

interface StaleProps {
  /** When the last sample arrived (epoch ms); undefined before the first. */
  readonly updatedAt?: number
  /** Set while the data is out of date: since when, and when the next attempt is due. */
  readonly stale?: { readonly since: number; readonly retryAt?: number }
  /** The current time; without it the badge keeps its own once-a-second clock. */
  readonly now?: number
}

/** The age of live data ("Updated 12 s ago"), or a warning badge while it is out of date ("Stale since 22:44:03 · retrying in 4 s"). */
export function StaleBadge({ updatedAt, stale, now }: StaleProps) {
  const clock = useTicker(now === undefined)
  const time = now ?? clock
  if (stale) {
    return <span className="stale-badge" data-stale="">
      <span className="codicon codicon-warning" aria-hidden="true" />
      <span>{staleLabel(stale.since, time, stale.retryAt)}</span>
    </span>
  }
  return <span className="stale-badge">{updatedLabel(updatedAt, time)}</span>
}
