import { useLayoutEffect, useRef, useState } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useTicker } from '../core/useTicker'
import { gridLimits as g } from '../grid/constants'
import { operationNoun, phaseText, type OperationKind, type ResultOperation } from './operations'
import { formatElapsed } from './status'

const cancelNames: Readonly<Record<OperationKind, string>> = { sort: 'Cancel sort', filter: 'Cancel filter', profile: 'Cancel profile', pivot: 'Cancel Pivot', compare: 'Cancel comparison' }

/**
 * The toolbar's strip for operations over whole results (ResultOperations): what runs on which result, its phase, a meter
 * with the percentage the backend reported (none while it has no total), the elapsed time once it passes 10 s, and Cancel.
 * A click on a control it holds off pulses it. The polite live region says when one starts and ends, never percentages;
 * a cancel leaves a notice that the previous view was kept.
 */
export default function OperationStrip({ tabId }: { tabId: string }) {
  const { results } = useWorkbench()
  const state = useServiceSnapshot(results.operations)[tabId]
  const shown = state?.items.filter(item => item.shown) ?? []
  // The display clock for the elapsed time, as the run summary's; progress itself comes only from the backend.
  const now = useTicker(shown.some(item => !item.ending))
  // A Cancel that goes while it has the keyboard focus (pressed, or its operation ended) gives the focus to the grid that
  // last had it, as Escape in the search box does, not to the page; one the user left first (a blur while it is still in
  // the page) gives nothing. Chromium may not blur an element it removes, so each
  // commit looks for the button.
  const anchor = useRef<HTMLSpanElement>(null), focused = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    const button = focused.current
    if (!button || button.isConnected) return
    focused.current = null
    const owner = anchor.current?.ownerDocument, active = owner?.activeElement
    if (!owner || (active && active !== owner.body)) return
    const grids = [...owner.querySelectorAll<HTMLElement>(`[data-result-grid][data-tab-id="${CSS.escape(tabId)}"]`)]
    ;(grids.find(grid => grid.dataset.paneFocus === 'selected') ?? grids[0])?.focus()
  })
  return <>
    {shown.map(item => <Strip key={item.id} item={item} now={now} cancel={() => results.operations.cancel(tabId, item.id)}
      onFocus={button => { focused.current = button }} onBlur={button => { if (focused.current === button && button.isConnected) focused.current = null }} />)}
    {state?.notice && <div className="op-strip op-notice">{state.notice}</div>}
    <Announcer key={tabId} anchor={anchor} text={state?.announcement ?? ''} announced={state?.announced ?? 0} />
  </>
}

/** The operations' live region for one query tab (keyed by it): a sentence from before the tab was shown stays unread, so
 *  switching query tabs repeats nothing (as OutputPane's Announcer). */
function Announcer({ anchor, text, announced }: { anchor: React.Ref<HTMLSpanElement>; text: string; announced: number }) {
  const [shownAt] = useState(announced)
  return <span ref={anchor} className="visually-hidden" aria-live="polite" data-announced={announced}>{announced > shownAt ? text : ''}</span>
}

function Strip({ item, now, cancel, onFocus, onBlur }: { item: ResultOperation; now: number; cancel: () => void; onFocus: (button: HTMLButtonElement) => void; onBlur: (button: HTMLButtonElement) => void }) {
  const name = `${operationNoun(item.kind)} ${item.target}`, phase = item.ending ? 'Done' : phaseText(item.phase)
  const elapsed = Math.max(now, item.updatedAt) - item.startedAt
  const percent = item.percent
  return <div className="op-strip" data-operation={item.kind} data-pulse={item.pulse === 0 ? undefined : item.pulse % 2 === 1 ? 'a' : 'b'}>
    <span className="op-what">{name}</span>
    <span className="op-phase">{phase}</span>
    <span className={'op-meter' + (percent === undefined ? ' indeterminate' : '')} role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100}
      {...percent === undefined ? { 'aria-valuetext': phase } : { 'aria-valuenow': percent, 'aria-valuetext': `${phase}, ${percent}%` }}>
      <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </span>
    {percent !== undefined && <span className="op-percent">{percent}%</span>}
    {!item.ending && elapsed >= g.operationElapsedMs && <span className="op-elapsed">{formatElapsed(elapsed)}</span>}
    {!item.ending && <button type="button" aria-label={`${cancelNames[item.kind]}, ${item.target}`} title="Cancel (Esc in the grid)" onClick={cancel}
      onFocus={event => onFocus(event.currentTarget)} onBlur={event => onBlur(event.currentTarget)}>Cancel</button>}
  </div>
}
