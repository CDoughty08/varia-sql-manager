import { updateStatusText, type UpdateState } from '../../../shared/updates'
import type { CommandId } from '../../../shared/commands/catalog'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { formatBytes } from '../results/status'

function details(state: UpdateState): { title: string; command?: CommandId } {
  switch (state.status) {
    case 'downloading': return { title: `Downloading Varia SQL Manager ${state.version}: ${formatBytes(state.received)} of ${formatBytes(state.total)}. It installs only when you choose Restart to Update.` }
    case 'preparing': return { title: `Varia SQL Manager ${state.version} is downloaded and verified, and is being unpacked so that restarting to update is quick.` }
    case 'ready': return { title: `Varia SQL Manager ${state.version} is downloaded and verified. Select to restart and install it.`, command: 'help.restartToUpdate' }
    case 'available': return state.size !== undefined
      ? { title: `Varia SQL Manager ${state.version} is available (${formatBytes(state.size)}). Select to download it.`, command: 'help.downloadUpdate' }
      : { title: `Varia SQL Manager ${state.version} is available. Select to open the releases page.`, command: 'help.releaseNotes' }
    case 'error': return { title: [state.message, state.hint, state.detail && `(${state.detail})`, 'Select to try again.'].filter(Boolean).join(' '), command: 'help.checkForUpdates' }
    default: return { title: 'Checking GitHub for a newer release.' }
  }
}

/**
 * The status bar's update segment, shown only while there is something to say: a check that Check for Updates started,
 * a download's progress, an update ready to install, or a failure (a blocked network included). Its words carry the
 * state; a button runs the command that acts on it. Progress is a polite live region at most four times a second.
 */
export default function UpdateStatus() {
  const { updates, commands } = useWorkbench()
  const state = useServiceSnapshot(updates)
  const text = updateStatusText(state)
  if (!text) return null
  const { title, command } = details(state)
  const icon = state.status === 'error' ? 'warning' : state.status === 'downloading' || state.status === 'preparing' || state.status === 'checking' ? 'cloud-download' : 'sync'
  const percent = state.status === 'downloading' && state.total ? Math.floor(state.received / state.total * 100) : undefined
  const content = <><Icon name={icon} />{state.status === 'error' && <span className="visually-hidden">Warning: </span>}<span>{text}</span></>
  return <span className="update-status" data-status={state.status}>
    {command
      ? <button type="button" title={title} aria-description={title} onClick={() => { void commands.execute(command, undefined, 'toolbar') }}>{content}</button>
      : <span role={percent === undefined ? 'status' : 'progressbar'} aria-label={percent === undefined ? undefined : 'Downloading update'} aria-valuemin={percent === undefined ? undefined : 0} aria-valuemax={percent === undefined ? undefined : 100} aria-valuenow={percent} title={title}>{content}</span>}
  </span>
}
