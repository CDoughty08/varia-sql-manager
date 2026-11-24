import { useWorkbench } from '../core/WorkbenchContext'
import type { CommandArgs } from '../core/types'
import { useCommandEnabled, useCommandsToggled, useKeybindingLabel } from '../core/useCommand'
import { withKey } from '../query-context'
import Icon from '../Icon'

export default function ClientStatisticsToggle({ classic = false, args, onBeforeExecute }: { classic?: boolean; args?: CommandArgs; onBeforeExecute?: () => void }) {
  const { commands } = useWorkbench(), id = 'query.includeClientStatistics'
  const enabled = useCommandEnabled(id, args), [pressed] = useCommandsToggled([id], args), key = useKeybindingLabel(id)
  return <button type="button" className={classic ? 'ui-button actual-plan-toggle' : 'ui-button query-bar-action actual-plan-toggle'}
    aria-label="Include Client Statistics" aria-keyshortcuts={key?.aria} aria-pressed={pressed} disabled={!enabled}
    title={withKey('Include Client Statistics', key)} onPointerDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => { onBeforeExecute?.(); void commands.execute(id, args, 'toolbar') }}>
    <Icon name="graph" /><span className="query-bar-label">Client Statistics</span>
  </button>
}
