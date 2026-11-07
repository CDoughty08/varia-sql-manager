import { useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled, useCommandsToggled, useKeybindingLabel } from '../core/useCommand'
import { withKey } from '../query-context'
import Icon from '../Icon'

export default function ClientStatisticsToggle({ classic = false }: { classic?: boolean }) {
  const { commands } = useWorkbench(), id = 'query.includeClientStatistics'
  const enabled = useCommandEnabled(id), [pressed] = useCommandsToggled([id]), key = useKeybindingLabel(id)
  return <button type="button" className={classic ? 'actual-plan-toggle' : 'query-bar-action actual-plan-toggle'}
    aria-label="Include Client Statistics" aria-keyshortcuts={key?.aria} aria-pressed={pressed} disabled={!enabled}
    title={withKey('Include Client Statistics', key)} onPointerDown={event => { if (event.button === 0) event.preventDefault() }} onClick={() => void commands.execute(id, undefined, 'toolbar')}>
    <Icon name="graph" /><span className="query-bar-label">Client Statistics</span>
  </button>
}
