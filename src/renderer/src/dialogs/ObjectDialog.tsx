import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react'
import { dialogSpecs, scriptActionTitles, type DialogId } from '../../../shared/actions/catalog.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { scriptDestinations, type ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import { trapFocus } from '../trap-focus'
import { dialogEnter } from './dialog-keys'
import type { DialogPhase, OpenObjectDialog } from './ObjectDialogService'
import FilegroupsPage from './pages/database/FilegroupsPage'
import FilesPage from './pages/database/FilesPage'
import GeneralPage from './pages/database/GeneralPage'
import OptionsPage from './pages/database/OptionsPage'
import DeleteObjectPage from './pages/DeleteObjectPage'

/** A page of an object dialog: the open dialog's snapshot, and whether its controls may change now. */
export interface PageProps { readonly open: OpenObjectDialog; readonly editable: boolean }
/** Each dialog's pages, by page id (the definitions in definitions.ts hold the behaviour). */
export const dialogPages: { readonly [D in DialogId]: Readonly<Record<string, ComponentType<PageProps>>> } = {
  deleteObject: { general: DeleteObjectPage },
  databaseProperties: { general: GeneralPage, files: FilesPage, filegroups: FilegroupsPage, options: OptionsPage }
}

const progressText: Readonly<Record<DialogPhase, string>> = {
  loading: 'Loading', ready: 'Ready', confirming: 'Ready', loadFailed: 'Error', scripting: 'Scripting', executing: 'Executing', failed: 'Error', stopped: 'Stopped', disconnected: 'Error'
}

/** The Script split button: the main part scripts to a new query window; the arrow lists the three destinations. */
function ScriptButton({ disabled, onScript }: { disabled: boolean; onScript(destination: ScriptDestination): void }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const arrow = useRef<HTMLButtonElement>(null)
  const choose = (destination: ScriptDestination) => { setOpen(false); arrow.current?.focus(); onScript(destination) }
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || ((event.key === 'Enter' || event.key === ' ') && event.currentTarget === arrow.current)) { event.preventDefault(); event.stopPropagation(); setActive(0); setOpen(true) }
      return
    }
    const move = (to: number) => setActive((to + scriptDestinations.length) % scriptDestinations.length)
    if (event.key === 'ArrowDown') move(active + 1)
    else if (event.key === 'ArrowUp') move(active - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(scriptDestinations.length - 1)
    else if (event.key === 'Enter' || event.key === ' ') choose(scriptDestinations[active])
    else if (event.key === 'Escape' || event.key === 'Tab') { setOpen(false); if (event.key === 'Tab') return }
    else return
    event.preventDefault()
    event.stopPropagation()
  }
  return <div className="object-dialog-script">
    <button type="button" className="object-dialog-script-main" disabled={disabled} onClick={() => onScript('newQuery')}><span className="codicon codicon-file-code" aria-hidden="true" />Script</button>
    <button ref={arrow} type="button" className="object-dialog-script-arrow" aria-label="Script options" aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
      aria-activedescendant={open ? `object-dialog-script-${scriptDestinations[active]}` : undefined} onClick={() => { setActive(0); setOpen(value => !value) }} onKeyDown={keyDown}
      onBlur={() => setOpen(false)}><span className="codicon codicon-chevron-down" aria-hidden="true" /></button>
    {open && <ul className="object-dialog-script-list" role="listbox" aria-label="Script">
      {scriptDestinations.map((destination, index) => <li key={destination} id={`object-dialog-script-${destination}`} role="option" aria-selected={index === active}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(destination)}>{scriptActionTitles[destination]}</li>)}
    </ul>}
  </div>
}

/**
 * SSMS's object dialog frame: "Select a page" with the Connection and Progress boxes on the left, the Script button and a
 * message bar above the page, OK and Cancel (Stop while it runs) below. Escape cancels; Enter is OK except on buttons and
 * lists. Closing returns focus to the tree row it was opened for.
 */
export default function ObjectDialog() {
  const { dialogs, explorer } = useWorkbench()
  const { open } = useServiceSnapshot(dialogs)
  // A dialog its own OK closed (the action succeeded) leaves focus nowhere: it returns to the tree, whose selection the
  // listing folder's reload has kept or moved to the folder.
  const shown = useRef(false)
  useEffect(() => {
    if (open) { shown.current = true; return }
    if (!shown.current) return
    shown.current = false
    if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }, [open])
  if (!open) return null
  const close = () => {
    if (!dialogs.close()) return
    if (explorer.menuNode(open.nodeId)) explorer.select(open.nodeId, { reveal: true })
    document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }
  return <ObjectDialogFrame key={open.id} open={open} close={close} />
}

function ObjectDialogFrame({ open, close }: { open: OpenObjectDialog; close(): void }) {
  const { dialogs } = useWorkbench()
  const spec = dialogSpecs[open.dialog]
  const Page = dialogPages[open.dialog][open.page]
  const executing = open.phase === 'executing', busy = executing || open.phase === 'loading' || open.phase === 'scripting' || open.phase === 'confirming'
  const usable = !!open.model && open.phase !== 'loadFailed' && open.phase !== 'disconnected'
  const nav = useRef<HTMLElement>(null), form = useRef<HTMLFormElement>(null)
  // The dialog takes focus as it opens, so Enter is OK and Escape is Cancel, as in SSMS.
  useEffect(() => { form.current?.focus() }, [])
  const pageKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = spec.pages.findIndex(page => page.id === open.page)
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : -1
    if (next < 0 || next >= spec.pages.length) return
    event.preventDefault()
    event.stopPropagation()
    dialogs.setPage(spec.pages[next].id)
    queueMicrotask(() => nav.current?.querySelector<HTMLElement>(`[data-page="${spec.pages[next].id}"]`)?.focus())
  }
  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    trapFocus(event)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!executing) close() }
    else if (event.key === 'Enter') {
      const enter = dialogEnter(event.target as Element)
      if (enter === 'native') return
      event.preventDefault()
      if (enter === 'ok') void dialogs.ok()
    }
  }
  const title = open.title
  const progress = progressText[open.phase]
  return <div className="modal-backdrop"><form ref={form} className={'connection-modal object-dialog' + (spec.size === 'large' ? ' large' : '')} role="dialog" aria-modal="true" aria-labelledby="object-dialog-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); void dialogs.ok() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="object-dialog-title">{title}</h2>
      <button type="button" className="icon-button" aria-label={'Close ' + title} disabled={executing} onClick={close}><Icon name="close" /></button></div>
    <div className="object-dialog-body">
      <div className="object-dialog-side">
        <nav ref={nav} className="object-dialog-pages" aria-label="Select a page" onKeyDown={pageKeyDown}>
          <div className="object-dialog-caption">Select a page</div>
          {spec.pages.map(page => <button key={page.id} type="button" data-page={page.id} aria-current={page.id === open.page ? 'page' : undefined} onClick={() => dialogs.setPage(page.id)}>
            <span className={`codicon codicon-${page.icon}`} aria-hidden="true" />{page.title}</button>)}
        </nav>
        <section className="object-dialog-box" aria-labelledby="object-dialog-connection">
          <div className="object-dialog-caption" id="object-dialog-connection">Connection</div>
          <dl><dt>Server:</dt><dd>{displayText(open.server)}</dd><dt>Connection:</dt><dd>{open.login ? displayText(open.login) : '—'}</dd></dl>
        </section>
        <section className="object-dialog-box" aria-labelledby="object-dialog-progress">
          <div className="object-dialog-caption" id="object-dialog-progress">Progress</div>
          <div className="object-dialog-progress" role="status">{busy && <span className="codicon codicon-loading object-dialog-spinner" aria-hidden="true" />}{progress}</div>
        </section>
      </div>
      <div className="object-dialog-main">
        <div className="object-dialog-toolbar"><ScriptButton disabled={busy || !usable} onScript={destination => void dialogs.script(destination)} /></div>
        {open.error && <div className={'object-dialog-message' + (open.phase === 'stopped' ? ' info' : '')} role={open.phase === 'stopped' ? 'status' : 'alert'}>
          <span className={`codicon codicon-${open.phase === 'stopped' ? 'info' : 'error'}`} aria-hidden="true" /><span>{open.error.message}</span></div>}
        {!open.error && open.notice && <div className="object-dialog-message info" role="status"><span className="codicon codicon-info" aria-hidden="true" /><span>{open.notice}</span></div>}
        <div className="object-dialog-page">{Page && <Page open={open} editable={usable && !busy} />}</div>
      </div>
    </div>
    <div className="connection-footer">
      <span />
      <button className="primary" type="submit" disabled={busy || open.phase === 'loadFailed' || open.phase === 'disconnected'}>OK</button>
      {executing ? <button type="button" onClick={() => dialogs.stop()}>Stop</button> : <button type="button" onClick={close}>{open.phase === 'disconnected' ? 'Close' : 'Cancel'}</button>}
    </div>
  </form></div>
}
