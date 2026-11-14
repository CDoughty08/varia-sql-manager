import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { discardSetting } from './OutputPane'

/**
 * The status bar's reminder that Discard results after execution is on, shown only while it is: every query reads its rows
 * and keeps none, so results that seem to be missing have a visible reason. Pressing it opens Options with the setting focused.
 */
export default function DiscardStatus() {
  const { settings, commands } = useWorkbench()
  const on = useServiceSnapshot(settings).values[discardSetting]
  if (!on) return null
  // Named by what it shows, as the update item beside it is; the description says what it means and does.
  return <span className="discard-status">
    <button type="button" className="discard-status-button" aria-description="Discard results after execution is on. Opens it in Options."
      title="Discard results after execution is on: queries read their rows and keep none. Click to change it in Options."
      onClick={() => void commands.execute('preferences.options', { setting: discardSetting }, 'toolbar')}>
      <Icon name="circle-slash" /><span>Results discarded</span>
    </button>
  </span>
}
