import { useEffect, useRef } from 'react'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { discardSetting } from './OutputPane'

/**
 * The status bar's reminder that Discard results after execution is on, shown only while it is: every query reads its rows
 * and keeps none, so results that seem to be missing have a visible reason. Pressing it opens Options with the setting focused.
 */
export default function DiscardStatus() {
  const { settings, commands, documents } = useWorkbench()
  const on = useServiceSnapshot(settings).values[discardSetting]
  const button = useRef<HTMLButtonElement>(null), refocus = useRef(false)
  // Read while rendering, before the commit removes the item that has the focus: the keyboard then goes to the active
  // document, unless something else took it meanwhile.
  if (!on && button.current && button.current === button.current.ownerDocument.activeElement) refocus.current = true
  useEffect(() => {
    if (on || !refocus.current) return
    refocus.current = false
    const focused = document.activeElement
    if (!focused || focused === document.body) documents.focusActive()
  }, [on, documents])
  if (!on) return null
  // Named by what it shows, as the update item beside it is; the description says what it means and does.
  return <span className="discard-status">
    <button ref={button} type="button" className="discard-status-button" aria-description="Discard results after execution is on. Opens it in Options."
      title="Discard results after execution is on: queries read their rows and keep none. Click to change it in Options."
      onClick={() => void commands.execute('preferences.options', { setting: discardSetting }, 'toolbar')}>
      <Icon name="circle-slash" /><span>Results discarded</span>
    </button>
  </span>
}
