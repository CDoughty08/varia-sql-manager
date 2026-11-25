import { useEffect, useState } from 'react'
import { browserTimers } from './timers'

/** The time, re-rendering at `intervalMs` while `running`: elapsed times in the query bar, output pane and query status bar. */
export function useTicker(running: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    let handle: unknown
    const tick = () => { setNow(Date.now()); handle = browserTimers.setTimeout(tick, intervalMs) }
    handle = browserTimers.setTimeout(tick, intervalMs)
    return () => browserTimers.clearTimeout(handle)
  }, [running, intervalMs])
  return now
}
