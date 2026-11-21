import { watchedText } from '../../../shared/agent/jobs'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import type { WatchedEntry } from './AgentJobStatusService'

const running = (entry: WatchedEntry) => entry.phase.phase === 'starting' || entry.phase.phase === 'running'

/**
 * The status bar's SQL Server Agent items (AG-3): the newest job this window started, with Stop while it runs and Dismiss,
 * and how many more there are; and, in its own item, Agent stopped (or its XPs off) on a server a Job Activity Monitor or a
 * followed job reads. Hidden while there is nothing to say. The connection item is left alone.
 */
export default function AgentJobStatus() {
  const { agentJobs, jobActivity, commands } = useWorkbench()
  const { jobs, agent } = useServiceSnapshot(agentJobs)
  const { documents } = useServiceSnapshot(jobActivity)
  const down = new Map<string, string>()
  for (const [connectionId, availability] of Object.entries(agent)) if (availability === 'stopped' || availability === 'xpsOff') down.set(connectionId, availability)
  for (const state of Object.values(documents)) {
    const availability = state.connectionId ? jobActivity.availability(state.id) : 'pending'
    if (state.connectionId && (availability === 'stopped' || availability === 'xpsOff')) down.set(state.connectionId, availability)
  }
  const servers = [...down.keys()].map(id => Object.values(documents).find(state => state.connectionId === id)?.label ?? jobs.find(entry => entry.connectionId === id)?.server ?? '')
  const newest = jobs[0]
  const more = jobs.length - 1
  if (!newest && !down.size) return null
  const xpsOnly = [...down.values()].every(value => value === 'xpsOff')
  // One server down: its monitor; several: the command's server picker.
  const openDown = () => {
    if (down.size !== 1) { void commands.execute('agent.jobActivity', undefined, 'toolbar'); return }
    try { jobActivity.open([...down.keys()][0]) } catch (error) { commands.reportError(error instanceof Error ? error.message : 'Job Activity Monitor could not open.') }
  }
  return <>
    {newest && <span className="agent-job-status" role="status" data-phase={newest.phase.phase}>
      <Icon name={running(newest) ? 'agent-activity' : newest.phase.phase === 'ended' && newest.phase.outcome === 1 ? 'pass' : 'warning'} />
      <span className="agent-job-status-text" title={`${newest.server}: ${watchedText(newest.name, newest.phase)}${newest.error ? ` · ${newest.error}` : ''}`}>
        {/* Always with its date: the client's today is not the server's. */}{watchedText(newest.name, newest.phase)}{newest.error ? ` · ${newest.error}` : ''}
      </span>
      {more > 0 && <span className="agent-job-status-more" title={jobs.slice(1).map(entry => watchedText(entry.name, entry.phase)).join('\n')}>+{more}</span>}
      {running(newest) && <button type="button" disabled={!!newest.stopping} onClick={() => void agentJobs.stop(newest.key)} aria-label={`Stop ${newest.name}`}>Stop</button>}
      <button type="button" onClick={() => agentJobs.dismiss(newest.key)} aria-label={`Dismiss ${newest.name}`}>Dismiss</button>
    </span>}
    {down.size > 0 && <span className="agent-stopped-status" role="status">
      <button type="button" title={down.size === 1 ? 'Open Job Activity Monitor on that server' : 'Open Job Activity Monitor'} onClick={openDown}>
        <Icon name="warning" /><span>{xpsOnly ? 'Agent XPs off' : 'SQL Server Agent stopped'}{servers.length === 1 && servers[0] ? ` on ${servers[0]}` : servers.length > 1 ? ` on ${servers.length} servers` : ''}</span>
      </button>
    </span>}
  </>
}
