import { useEffect, useState } from 'react'
import { browserTimers } from './timers'

/** The time, re-rendering once a second while `running`: elapsed times in the output pane and the query status bar. */
export function useTicker(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    let handle: unknown
    const tick = () => { setNow(Date.now()); handle = browserTimers.setTimeout(tick, 1000) }
    handle = browserTimers.setTimeout(tick, 1000)
    return () => browserTimers.clearTimeout(handle)
  }, [running])
  return now
}
