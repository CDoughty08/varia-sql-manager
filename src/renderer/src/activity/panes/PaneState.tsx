// A pane's own state around its grid (docs/activity-monitor.md, Panes): loading until its first sample, its probe's
// failure (the last rows stay, dimmed, with the reason, as each probe fails alone), or its table refused or unavailable.
// The document-level banners (permission, backend lost, server not covered) stay ActivityMonitor's.
import type { ReactNode } from 'react'
import InlineError from '../../kit/InlineError'
import Skeleton from '../../kit/Skeleton'
import type { LiveProbeSnapshot } from '../../live/LiveService'

export interface PaneProblem {
  /** failing: the last sample failed and the probe retries by itself; refused: this table cannot be read here. */
  readonly kind: 'failing' | 'refused'
  readonly code?: string
  readonly message: string
}

/** What stops a pane's table, from its probe's state: an error that names other tables only leaves this one alone. */
export function paneProblem(probe: LiveProbeSnapshot | undefined, table: number): PaneProblem | undefined {
  if (!probe) return undefined
  if (probe.state === 'unavailable') return { kind: 'refused', code: probe.reason, message: probe.note ?? 'This pane is not available on this server.' }
  const error = probe.error
  if (!error || (error.tables && !error.tables.includes(table))) return undefined
  if (error.terminal || error.code === 'PERMISSION_DENIED' || error.code === 'NOT_SUPPORTED') return { kind: 'refused', code: error.code, message: error.message }
  return probe.state === 'failing' || probe.state === 'stale' ? { kind: 'failing', code: error.code, message: error.message } : undefined
}

export default function PaneState({ problem, hasRows, children }: { readonly problem: PaneProblem | undefined; readonly hasRows: boolean; readonly children: ReactNode }) {
  if (problem?.kind === 'refused' && !hasRows) return <div className="activity-pane-grid"><InlineError className="activity-pane-notice" role="status" code={problem.code} message={problem.message} copy={false} /></div>
  return <div className="activity-pane-grid" data-stale={problem && hasRows ? '' : undefined}>
    {problem && <InlineError className="activity-pane-notice" role="status" code={problem.code} message={hasRows ? `${problem.message} The rows below are from the last sample that succeeded.` : problem.message} copy={false} />}
    {/* The grid is mounted and laid out from the start, so its first sample lands in a grid that is already sized; until
        then the placeholder rows cover it. */}
    <div className="activity-pane-rows">
      {children}
      {!hasRows && !problem && <div className="activity-pane-loading"><Skeleton rows={6} label="Waiting for the first sample" /></div>}
    </div>
  </div>
}
