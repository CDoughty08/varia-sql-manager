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
  return <>
    {shown.map(item => <Strip key={item.id} item={item} now={now} cancel={() => results.operations.cancel(tabId, item.id)} />)}
    {state?.notice && <div className="op-strip op-notice">{state.notice}</div>}
    <span className="visually-hidden" aria-live="polite" data-announced={state?.announced ?? 0}>{state?.announcement ?? ''}</span>
  </>
}

function Strip({ item, now, cancel }: { item: ResultOperation; now: number; cancel: () => void }) {
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
    {!item.ending && <button type="button" aria-label={`${cancelNames[item.kind]}, ${item.target}`} title="Cancel (Esc in the grid)" onClick={cancel}>Cancel</button>}
  </div>
}
