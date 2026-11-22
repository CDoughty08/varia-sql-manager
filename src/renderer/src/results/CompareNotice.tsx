import { useSyncExternalStore } from 'react'
import Icon from '../Icon'
import { useWorkbench } from '../core/WorkbenchContext'
import { focusResultGrid } from '../grid/ResultGrid'

/**
 * A first comparison that All rows could not fit (`DIFF_ROWS_TOO_LARGE`) with no Compare popover left to say it, in the
 * results toolbar: its pair, the refusal, Show changes only (the same comparison with Changes only) and Dismiss. It stays
 * until acted on, dismissed, its pair shown, an input closed or its run gone (so Show changes only never meets a closed
 * input; it still says why if it did, D10); a later notice of the tab (a copy, a save) does not replace it.
 */
export default function CompareNotice({ tabId }: { readonly tabId: string }) {
  const { compare, results } = useWorkbench()
  const notice = useSyncExternalStore(compare.subscribe, () => compare.getSnapshot().actionable[tabId])
  // The reason reads the run's entries: read again whenever either store changes.
  const reason = useSyncExternalStore(results.subscribe, () => compare.actionableReason(tabId))
  if (!notice) return null
  const action = 'Show changes only'
  return <div className="job-strip compare-refused" role="group" aria-label="Comparison notice">
    <Icon name="warning" />
    <span>Compare {notice.names[0]} with {notice.names[1]}: {notice.text}</span>
    <button type="button" {...reason ? { 'aria-disabled': true, title: `${action}: unavailable because ${reason}` } : { title: 'Compare them again with Changes only: only changed, added and removed rows' }}
      onClick={event => {
        if (reason) return
        // The notice goes as it runs: the focus waits on the selected view tab, then moves to the comparison once shown.
        const owner = event.currentTarget.ownerDocument, view = event.currentTarget.closest('.output-toolbar')?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')
        const run = compare.runActionable(tabId)
        view?.focus({ preventScroll: true })
        void run.then(key => { if (key !== undefined) focusResultGrid(owner, tabId, key) })
      }}>{action}</button>
    <button type="button" className="icon-button" aria-label="Dismiss comparison notice" title="Dismiss" onClick={event => {
      // The notice goes with its buttons: the focus moves to the results toolbar's selected view tab.
      const view = event.currentTarget.closest('.output-toolbar')?.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')
      compare.clearActionable(tabId)
      view?.focus({ preventScroll: true })
    }}><Icon name="close" /></button>
  </div>
}
