import { useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { productDescription, productName } from '../../../shared/product'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { useCommandEnabled } from '../core/useCommand'
import { focusToReturn, returnFocusTo } from '../core/focus'
import Icon from '../Icon'
import InlineError from '../kit/InlineError'
import { copyStatus, copyText, type CopyRecord } from '../kit/format'
import { trapFocus } from '../trap-focus'
import { aboutUpdate, platformName, versionDetails, type AboutUpdateCommand } from './about'

export default function AboutDialog({ onClose }: { readonly onClose: () => void }) {
  const { commands, documents, platform, updates } = useWorkbench()
  const state = useServiceSnapshot(updates), update = aboutUpdate(state, platform), details = versionDetails(state, platform)
  const [returnFocus] = useState(focusToReturn)
  const [copied, setCopied] = useState<CopyRecord>()
  const [error, setError] = useState('')
  const action = update.action
  const actionEnabled = useCommandEnabled(action?.command ?? 'help.checkForUpdates')
  const close = () => {
    onClose()
    if (returnFocus?.isConnected) returnFocusTo(returnFocus)
    else documents.focusActive()
  }
  const run = async (id: AboutUpdateCommand | 'help.openProject' | 'help.reportIssue') => {
    setError('')
    // Restart's quit needs the modal gone before the normal window-close command can ask about unsaved work.
    if (id === 'help.restartToUpdate') {
      flushSync(close)
      await commands.execute(id, undefined, 'toolbar')
      return
    }
    // These controls belong to this dialog. The programmatic path permits them through its own modal guard,
    // while execute still checks the catalogue/handler preconditions and reports errors normally.
    if (!await commands.execute(id, undefined, 'api')) setError(commands.getSnapshot().error || 'This action is not available right now.')
  }
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }
  return <div className="modal-backdrop"><section className="connection-modal about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="about-title">About Varia</h2><button type="button" className="icon-button" aria-label="Close About Varia" onClick={close}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <div className="about-identity"><div className="about-brand"><Icon name="varia" /></div><div><h3>{productName}</h3><p>{productDescription}</p></div></div>
      <p className="about-version">{state.currentVersion ? `Version ${state.currentVersion}` : 'Version information unavailable'}<span>{platformName(platform)}</span></p>
      <section className="about-update" aria-label="Application updates" data-state={state.status}>
        <div className="about-update-heading"><Icon name={state.status === 'error' ? 'warning' : update.busy ? 'sync' : 'info'} spin={update.busy} /><div><div role="status"><h3>{update.title}</h3></div><p>{update.detail}</p></div></div>
        {state.status === 'downloading' && <div className="about-progress" role="progressbar" aria-label="Downloading update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={update.percent}>
          {update.percent !== undefined && <span style={{ width: `${update.percent}%` }} />}
        </div>}
        {(action || update.busy) && <button type="button" className="about-update-action" aria-disabled={!action || !actionEnabled || undefined}
          onClick={() => { if (action && actionEnabled) void run(action.command) }}>{action?.label ?? 'Update in progress'}<Icon name={action?.command === 'help.releaseNotes' ? 'link-external' : 'chevron-right'} /></button>}
      </section>
      <div className="about-links">
        <button type="button" onClick={() => { void run('help.releaseNotes') }}>Release Notes<Icon name="link-external" /></button>
        <button type="button" onClick={() => { void run('help.openProject') }}>Project on GitHub<Icon name="link-external" /></button>
        <button type="button" onClick={() => { void run('help.reportIssue') }}>Report an Issue<Icon name="link-external" /></button>
      </div>
      <div className="about-copy"><button type="button" onClick={() => { void copyText(window.varia.writeClipboardText, details).then(setCopied) }}><Icon name="copy" />Copy Version Details</button><span role="status">{copyStatus(copied, details)}</span></div>
      <details className="about-details"><summary>Version details</summary><pre>{details}</pre></details>
      {error && <InlineError message={error} copy={false} />}
    </div>
    <div className="connection-footer"><span /><button type="button" autoFocus onClick={close}>Done</button></div>
  </section></div>
}
