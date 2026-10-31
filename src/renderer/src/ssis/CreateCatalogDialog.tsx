import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ssisActions, ssisLimits } from '../../../shared/ssis/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import StepList from '../kit/StepList'
import { trapFocus } from '../trap-focus'
import type { OpenCreateCatalog } from './CreateCatalogService'

/** The steps Create Catalog will run on this server: CLR only when it is off. */
function plannedSteps(open: OpenCreateCatalog): readonly string[] {
  const steps = ssisActions.createCatalog.steps
  return open.setup?.clrEnabled ? steps.slice(1) : steps
}

/**
 * SSMS's Create Catalog dialog (S9a), opened from Integration Services Catalogs: Enable CLR Integration (checked and fixed
 * when CLR is on; until it is checked nothing else can change), the startup procedure, the catalog's fixed name, and the
 * encryption password typed twice, plus what the server will get. The password lives in this form only, never in a
 * service's snapshot, and goes with the dialog. Enter is Create and Escape is Cancel; Stop replaces Cancel while it runs.
 */
export default function CreateCatalogDialog() {
  const { ssisCatalog, explorer } = useWorkbench()
  const { open } = useServiceSnapshot(ssisCatalog)
  const shown = useRef(false)
  useEffect(() => {
    if (open) { shown.current = true; return }
    if (!shown.current) return
    shown.current = false
    if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }, [open])
  if (!open) return null
  const close = () => {
    if (!ssisCatalog.close()) return
    if (explorer.menuNode(open.nodeId)) explorer.select(open.nodeId, { reveal: true })
    document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }
  return <CreateCatalogForm key={open.id} open={open} close={close} />
}

function CreateCatalogForm({ open, close }: { open: OpenCreateCatalog; close(): void }) {
  const { ssisCatalog } = useWorkbench()
  const [password, setPassword] = useState('')
  const [retyped, setRetyped] = useState('')
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => { form.current?.focus() }, [])
  const executing = open.phase === 'executing'
  const editable = open.phase === 'ready' || open.phase === 'failed' || open.phase === 'stopped'
  // SSMS: until CLR integration is checked, only its checkbox can change.
  const fields = editable && open.enableClr
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!executing) close() }
  }
  const status = open.phase === 'loading' ? 'Reading the server…' : executing ? (open.stopping ? `Stopping… A restore that has started gets up to ${ssisLimits.restoreStopMs / 1000} s more to end; then Create Catalog removes what it created.` : 'Creating the catalog…') : ''
  const steps = open.steps ?? []
  const describedBy = open.problem ? 'create-catalog-problem' : undefined
  return <div className="modal-backdrop"><form ref={form} className="connection-modal create-catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="create-catalog-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); if (fields) void ssisCatalog.create(password, retyped) }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="create-catalog-title">Create Catalog</h2>
      <button type="button" className="icon-button" aria-label="Close Create Catalog" disabled={executing} onClick={close}><Icon name="close" /></button></div>
    <div className="connection-scroll">
      <p className="field-note">Server: {displayText(open.server)}{open.login ? ` · ${displayText(open.login)}` : ''}</p>
      {open.phase === 'loading' && <p className="field-note" role="status"><Icon name="loading" className="object-dialog-spinner" /> {status}</p>}
      {open.setup && <>
        <fieldset className="property-section" disabled={!editable}>
          <legend>Options</legend>
          <p className="field-note">To create and use the catalog, CLR integration must be enabled on the current SQL Server instance.</p>
          <label className="checkbox-label"><input type="checkbox" checked={open.enableClr} disabled={open.setup.clrEnabled}
            onChange={event => ssisCatalog.setEnableClr(event.target.checked)} />Enable CLR Integration</label>
          <label className="checkbox-label"><input type="checkbox" checked={open.startupProcedure} disabled={!fields}
            onChange={event => ssisCatalog.setStartupProcedure(event.target.checked)} />Enable automatic execution of Integration Services stored procedure at SQL Server startup</label>
        </fieldset>
        <fieldset className="property-section property-grid" disabled={!fields}>
          <legend>Catalog</legend>
          <div className="property-row"><label htmlFor="create-catalog-name">Name of the catalog database</label><input id="create-catalog-name" type="text" readOnly value={open.setup.catalog} /></div>
          <p className="field-note">The catalog protects data using encryption. A key is needed for this encryption. Enter a password to protect the encryption key, and save the password in a secure location.</p>
          <div className="property-row"><label htmlFor="create-catalog-password">Password</label>
            <input id="create-catalog-password" type="password" autoComplete="new-password" spellCheck={false} maxLength={ssisLimits.catalogPassword} value={password}
              aria-describedby={describedBy} onChange={event => setPassword(event.target.value)} /></div>
          <div className="property-row"><label htmlFor="create-catalog-retype">Retype Password</label>
            <input id="create-catalog-retype" type="password" autoComplete="new-password" spellCheck={false} maxLength={ssisLimits.catalogPassword} value={retyped}
              aria-describedby={describedBy} onChange={event => setRetyped(event.target.value)} /></div>
          <p className="field-note">You can manage the encryption key by creating a backup. If you migrate or move the Integration Services catalog to another SQL Server instance, you can restore the key to regain access to encrypted content.</p>
        </fieldset>
        <section className="property-section create-catalog-plan" aria-labelledby="create-catalog-plan">
          <div className="create-catalog-caption" id="create-catalog-plan">This changes the server</div>
          <StepList labelledBy="create-catalog-plan" steps={steps.length ? steps.map(step => ({ state: step.status, text: step.message ?? '' })) : plannedSteps(open).map(text => ({ state: 'pending', text }))} />
          <dl className="create-catalog-files">
            <dt>Backup</dt><dd className="create-catalog-path">{open.setup.backupFile}</dd>
            <dt>Data file</dt><dd className="create-catalog-path">{open.setup.dataFile}</dd>
            <dt>Log file</dt><dd className="create-catalog-path">{open.setup.logFile}</dd>
          </dl>
        </section>
      </>}
      {executing && <p className="field-note create-catalog-status" role="status"><Icon name="loading" className="object-dialog-spinner" /> {status}</p>}
      {open.problem && <p className="connect-error" id="create-catalog-problem" role="alert">{open.problem}</p>}
      {open.error && <p className={'connect-error' + (open.phase === 'stopped' ? ' info' : '')} role={open.phase === 'stopped' ? 'status' : 'alert'}>{open.error.message}</p>}
    </div>
    {/* A window close or Restart refused while Create Catalog runs: the dialog covers the command banner, so it says why
        here, outside the scroll, above Stop. */}
    {executing && open.refusal && <p className="connect-error create-catalog-refusal" role="alert">{open.refusal}</p>}
    <div className="connection-footer">
      <span />
      <button className="primary" type="submit" disabled={!fields}>OK</button>
      {executing ? <button type="button" disabled={open.stopping} onClick={() => ssisCatalog.stop()}>Stop</button>
        : <button type="button" onClick={close}>{open.phase === 'disconnected' ? 'Close' : 'Cancel'}</button>}
    </div>
  </form></div>
}
