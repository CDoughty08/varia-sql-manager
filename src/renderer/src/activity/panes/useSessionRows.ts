// A session pane's row actions (Sessions, Blocking, Active Expensive Queries): Details and Kill Process on the session its
// grid's active row names. Query Output's menu and the catalogue's commands reach them through the grid (LiveOutput.rows),
// the palette through ActivityMonitorService. Enablement reads the session last read for the active row (read again as the
// active row or the revision changes); an action reads the row again first, since a right-click moves the selection just
// before the menu runs.
import { useEffect, useMemo, useRef, useState } from 'react'
import { onUnexpectedError } from '../../core/errors'
import { useWorkbench } from '../../core/WorkbenchContext'
import type { LiveGrid } from '../../live/LiveGrid'
import type { LiveRowAction, LiveRowActions } from '../../menus/targets'
import { isVariaPool, jobUnavailable, sessionColumns, sessionFromRow, type SessionRef, type SessionTable } from '../session-actions'

export interface SessionRows {
  /** For LiveGridPane: its LiveGrid, once built. */
  readonly onGrid: (grid: LiveGrid | undefined) => void
  readonly rows: LiveRowActions
  /** For the pane's root: a focused grid makes these the palette's rows. */
  readonly onFocus: () => void
  /** For LiveGridPane: a click or Enter on a link cell (the Agent Job column) opens the job of the active row, if it runs one. */
  readonly onOpenLink: () => void
}

/** What an action says when the active row names no session it can act on. */
export const noSessionText = 'Select a session first: this row names no session that is still in the sample.'

export function useSessionRows(monitorId: string, table: SessionTable): SessionRows {
  const { activity, commands } = useWorkbench()
  const [grid, setGrid] = useState<LiveGrid>()
  const current = useRef<{ grid?: LiveGrid; key?: string; session?: SessionRef }>({})
  const { rows, openLink } = useMemo<{ rows: LiveRowActions; openLink: () => void }>(() => {
    const read = async (): Promise<SessionRef | undefined> => {
      const shown = current.current.grid
      return shown && sessionFromRow(table, await shown.activeRow(sessionColumns(table)))
    }
    const act = (action: LiveRowAction, session: SessionRef) => {
      if (action === 'details') activity.openDetails(monitorId, session)
      else if (action === 'openJob') { const why = activity.openJob(monitorId, session); if (why) commands.reportWarning(why) }
      else if (action === 'stopJob') void activity.stopJob(monitorId, session)
      // The confirm refuses what Kill may not end (the permission, Varia's own pools) and says why.
      else activity.askKill(monitorId, session)
    }
    const rows: LiveRowActions = {
      kind: 'session',
      // A right-click moves the active row just before the menu asks, while the row's session is still being read: until
      // that read lands, any active row enables both (the action reads the row again, and the confirm refuses a pool).
      // Once it lands, Kill is never offered for Varia's own pools.
      can: action => {
        const { grid: shown, key, session } = current.current
        const snapshot = shown?.getSnapshot()
        if (!snapshot?.selection) return false
        if (snapshot.activeKey === undefined || snapshot.activeKey !== key) return true
        if (action === 'openJob' || action === 'stopJob') return !jobUnavailable(session, action === 'openJob' ? 'open' : 'stop')
        return !!session && (action === 'details' || !isVariaPool(session))
      },
      run: action => {
        read().then(session => {
          if (session) act(action, session)
          else commands.reportWarning(noSessionText)
        }, onUnexpectedError)
      }
    }
    // A link cell opens the row's job; the empty Agent Job cell of a session that runs none does nothing.
    const openLink = () => { read().then(session => { if (session?.job) act('openJob', session) }, onUnexpectedError) }
    return { rows, openLink }
  }, [activity, commands, monitorId, table])
  useEffect(() => activity.registerSessionRows(monitorId, rows).dispose, [activity, monitorId, rows])
  useEffect(() => {
    current.current = { grid }
    if (!grid) return
    const columns = sessionColumns(table)
    let reads = 0, last: { key?: string; table?: unknown } = {}
    const update = () => {
      const snapshot = grid.getSnapshot()
      if (snapshot.activeKey === last.key && snapshot.table === last.table) return
      last = { key: snapshot.activeKey, table: snapshot.table }
      const mine = ++reads
      grid.activeRow(columns).then(cells => { if (mine === reads && current.current.grid === grid) current.current = { grid, key: last.key, session: sessionFromRow(table, cells) } }, onUnexpectedError)
    }
    update()
    const stop = grid.subscribe(update)
    return () => { reads++; stop(); current.current = {} }
  }, [grid, table])
  return { onGrid: setGrid, rows, onFocus: () => activity.focusSessionRows(monitorId, rows), onOpenLink: openLink }
}
