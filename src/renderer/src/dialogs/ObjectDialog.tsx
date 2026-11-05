import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type Ref } from 'react'
import { dialogSpecs, scriptActionTitles, type DialogPageSpec, type ModalDialogId, type PageId } from '../../../shared/actions/catalog.ts'
import type { ActionStep } from '../../../shared/actions/schema.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { scriptDestinations, type ScriptDestination } from '../../../shared/scripting/catalog.ts'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import Icon from '../Icon'
import StepList from '../kit/StepList'
import { trapFocus } from '../trap-focus'
import { definitionOf } from './definitions'
import { dialogEnter } from './dialog-keys'
import type { DialogPhase, OpenObjectDialog } from './ObjectDialogService'
import AttachDatabasePage from './pages/AttachDatabasePage'
import DatabaseStatePage from './pages/DatabaseStatePage'
import DeleteObjectPage from './pages/DeleteObjectPage'
import DetachDatabasePage from './pages/DetachDatabasePage'
import { NewLoginGeneralPage, NewLoginServerRolesPage, NewLoginStatusPage } from './pages/NewLoginPages'
import SecurablesPage from './pages/SecurablesPage'
import UserMappingPage from './pages/UserMappingPage'
import UnlockLoginPage from './pages/UnlockLoginPage'
import { findInWindows, returnFocusTo } from '../core/focus'

/** A page of an object dialog: the open dialog's snapshot, and whether its controls may change now. */
export interface PageProps { readonly open: OpenObjectDialog; readonly editable: boolean }
/** Each modal dialog's pages, by page id (the definitions in definitions.ts hold the behaviour). Database Properties is a
 *  document instead (src/renderer/src/properties). */
export const dialogPages: { readonly [D in ModalDialogId]: Readonly<Partial<Record<PageId, ComponentType<PageProps>>>> } = {
  deleteObject: { general: DeleteObjectPage },
  attachDatabase: { general: AttachDatabasePage },
  newLogin: { general: NewLoginGeneralPage, serverRoles: NewLoginServerRolesPage, userMapping: UserMappingPage, securables: SecurablesPage, status: NewLoginStatusPage },
  takeOffline: { general: DatabaseStatePage },
  bringOnline: { general: DatabaseStatePage },
  detachDatabase: { general: DetachDatabasePage },
  unlockLogin: { general: UnlockLoginPage },
  // Login Properties (D2c) shows New Login's pages on the login, each in its properties form.
  loginProperties: { general: NewLoginGeneralPage, serverRoles: NewLoginServerRolesPage, userMapping: UserMappingPage, securables: SecurablesPage, status: NewLoginStatusPage }
}
/** The pages "Select a page" lists for a model: the spec's, less those the definition hides for it (definition.hiddenPages). */
export function shownPages(pages: readonly DialogPageSpec[], hidden: readonly PageId[]): readonly DialogPageSpec[] {
  return hidden.length ? pages.filter(page => !hidden.includes(page.id)) : pages
}

const progressText: Readonly<Record<DialogPhase, string>> = {
  loading: 'Loading', ready: 'Ready', confirming: 'Ready', loadFailed: 'Error', scripting: 'Scripting', executing: 'Executing', succeeded: 'Success', failed: 'Error', stopped: 'Stopped', disconnected: 'Error'
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
    <button type="button" className="object-dialog-script-main" disabled={disabled} onClick={() => onScript('newQuery')}><Icon name="file-code" />Script</button>
    <button ref={arrow} type="button" className="object-dialog-script-arrow" aria-label="Script options" aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
      aria-activedescendant={open ? `object-dialog-script-${scriptDestinations[active]}` : undefined} onClick={() => { setActive(0); setOpen(value => !value) }} onKeyDown={keyDown}
      onBlur={() => setOpen(false)}><Icon name="chevron-down" /></button>
    {open && <ul className="object-dialog-script-list" role="listbox" aria-label="Script">
      {scriptDestinations.map((destination, index) => <li key={destination} id={`object-dialog-script-${destination}`} role="option" aria-selected={index === active}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(destination)}>{scriptActionTitles[destination]}</li>)}
    </ul>}
  </div>
}

/** Whether Script can run in a phase: never while something runs, and not once a dialog that stays open has succeeded (only
 *  Close is left then, as in SSMS's progress dialogs). */
export function scriptAvailable(phase: DialogPhase, usable: boolean): boolean {
  return usable && phase !== 'executing' && phase !== 'loading' && phase !== 'scripting' && phase !== 'confirming' && phase !== 'succeeded'
}

/**
 * SSMS's object dialog frame: "Select a page" with the Connection and Progress boxes on the left (a row of tabs above
 * them in a dialog under 720 px), the Script button and a message bar above the page, the run's steps when the dialog's
 * spec asks for them, and OK and Cancel (Stop while it runs) below, with why OK cannot run yet beside them. A dialog that stays
 * open after its run (Take Offline, Bring Online) then shows only Close, focused. Escape cancels; Enter is OK except on
 * buttons and lists. Closing returns focus to the tree row it was opened for.
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
    if (!document.activeElement || document.activeElement === document.body) returnFocusTo(findInWindows('[data-explorer-tree]'))
  }, [open])
  if (!open) return null
  const close = () => {
    if (!dialogs.close()) return
    if (explorer.menuNode(open.nodeId)) explorer.select(open.nodeId, { reveal: true })
    document.querySelector<HTMLElement>('[data-explorer-tree]')?.focus()
  }
  return <ObjectDialogFrame key={open.id} open={open} close={close} />
}

/** The dialog reflows below this viewport width, where it is narrower than 720 px: the page list becomes a row of tabs. */
export const narrowFrameQuery = '(max-width: 767px)'
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia(query), changed = () => setMatches(list.matches)
    changed()
    list.addEventListener('change', changed)
    return () => list.removeEventListener('change', changed)
  }, [query])
  return matches
}

/**
 * The pages a frame renders: the current one, and each `keepMounted` page once it has been shown (hidden while another
 * is), so its own state (a password field, a cell being edited) survives a page switch. Others mount when shown.
 */
export function framePages(pages: readonly DialogPageSpec[], current: PageId, visited: ReadonlySet<PageId>): readonly { readonly page: DialogPageSpec; readonly shown: boolean }[] {
  return pages.flatMap(page => page.id === current || page.keepMounted && visited.has(page.id) ? [{ page, shown: page.id === current }] : [])
}
/** The page after `current` for a key: Up and Down in the list, Left and Right (and Home and End) as tabs. */
export function pageForKey(pages: readonly DialogPageSpec[], current: PageId, key: string, tabs: boolean): PageId | undefined {
  const index = pages.findIndex(page => page.id === current)
  const next = key === (tabs ? 'ArrowRight' : 'ArrowDown') ? index + 1 : key === (tabs ? 'ArrowLeft' : 'ArrowUp') ? index - 1 : tabs && key === 'Home' ? 0 : tabs && key === 'End' ? pages.length - 1 : -1
  return next >= 0 && next < pages.length && next !== index ? pages[next].id : undefined
}
export const pageTabId = (page: PageId) => `object-dialog-tab-${page}`
export const pagePanelId = (page: PageId) => `object-dialog-panel-${page}`

/**
 * "Select a page": a list of page buttons (the current one `aria-current`), or, in a narrow dialog, a `tablist` whose tabs
 * control the page panels that are rendered (`rendered`; the current page's when absent): a page not mounted yet has no
 * panel for its tab to name. Each page shows its catalogue icon.
 */
export function PageList({ pages, current, tabs, rendered, onPage, onKeyDown, navRef }: {
  readonly pages: readonly DialogPageSpec[]; readonly current: PageId; readonly tabs: boolean; readonly rendered?: ReadonlySet<PageId>; onPage(page: PageId): void; onKeyDown?(event: KeyboardEvent<HTMLElement>): void; readonly navRef?: Ref<HTMLElement>
}) {
  const controls = (page: PageId) => (rendered ? rendered.has(page) : page === current) ? pagePanelId(page) : undefined
  const buttons = pages.map(page => <button key={page.id} type="button" data-page={page.id} onClick={() => onPage(page.id)} {...tabs
    ? { role: 'tab', id: pageTabId(page.id), 'aria-selected': page.id === current, 'aria-controls': controls(page.id), tabIndex: page.id === current ? 0 : -1 }
    : { 'aria-current': page.id === current ? 'page' as const : undefined }}><Icon name={page.icon} />{page.title}</button>)
  return tabs
    ? <nav ref={navRef} className="object-dialog-pages tabs" aria-label="Pages"><div className="object-dialog-tabs" role="tablist" aria-label="Select a page" onKeyDown={onKeyDown}>{buttons}</div></nav>
    : <nav ref={navRef} className="object-dialog-pages" aria-label="Select a page" onKeyDown={onKeyDown}><div className="object-dialog-caption">Select a page</div>{buttons}</nav>
}

/** A run's steps under the message bar, for dialogs whose spec asks for them (`DialogSpec.steps`), each by its title (a
 *  failed step's SQL Server text is in the message bar). A long list scrolls, and a new step scrolls it to the end, where the run is. */
export function StepsPanel({ steps }: { readonly steps: readonly ActionStep[] }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => { if (panel.current) panel.current.scrollTop = panel.current.scrollHeight }, [steps.length])
  if (!steps.length) return null
  return <section ref={panel} className="object-dialog-steps" aria-labelledby="object-dialog-steps">
    <div className="object-dialog-caption" id="object-dialog-steps">Steps</div>
    <StepList labelledBy="object-dialog-steps" steps={steps.map(step => ({ state: step.status, text: step.detail ? `${step.title}: ${step.detail}` : step.title }))} />
  </section>
}

function ObjectDialogFrame({ open, close }: { open: OpenObjectDialog; close(): void }) {
  const { dialogs } = useWorkbench()
  const spec = dialogSpecs[open.dialog]
  const pages = shownPages(spec.pages, open.model ? definitionOf(open.dialog).hiddenPages?.(open.model) ?? [] : [])
  const components: Partial<Record<PageId, ComponentType<PageProps>>> = dialogPages[open.dialog]
  const executing = open.phase === 'executing', busy = executing || open.phase === 'loading' || open.phase === 'scripting' || open.phase === 'confirming'
  const succeeded = open.phase === 'succeeded', blocked = dialogs.blockedReason(open)
  const closeButton = useRef<HTMLButtonElement>(null), stopButton = useRef<HTMLButtonElement>(null)
  // A run that succeeded leaves Close as the one button, focused, as SSMS's progress dialogs do.
  useEffect(() => { if (succeeded) closeButton.current?.focus() }, [succeeded])
  const usable = !!open.model && open.phase !== 'loadFailed' && open.phase !== 'disconnected'
  // Unlock's Set a new password… hands over to Login Properties, and OK says so.
  const okLabel = (open.draft && definitionOf(open.dialog).okLabel?.(open.draft)) || 'OK'
  const nav = useRef<HTMLElement>(null), form = useRef<HTMLFormElement>(null)
  // OK disables itself as the run starts, which drops focus to the page; Stop is then the way out (Escape does nothing while
  // it runs, and SET OFFLINE can wait indefinitely), so focus moves there unless it is on a control that can still be used.
  useEffect(() => {
    if (!executing) return
    const active = document.activeElement
    if (!active || active === document.body || !form.current?.contains(active) || (active as HTMLButtonElement).disabled) stopButton.current?.focus()
  }, [executing])
  const tabs = useMediaQuery(narrowFrameQuery)
  const [visited, setVisited] = useState<ReadonlySet<PageId>>(() => new Set([open.page]))
  useEffect(() => setVisited(seen => seen.has(open.page) ? seen : new Set([...seen, open.page])), [open.page])
  // The dialog takes focus as it opens, so Enter is OK and Escape is Cancel, as in SSMS.
  useEffect(() => { form.current?.focus() }, [])
  // Once the object is read, a definition may send focus to one field: Login Properties opened by Unlock's hand-off, to the password.
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current || open.phase !== 'ready' || !open.model || !open.draft) return
    focused.current = true
    const id = definitionOf(open.dialog).initialFocus?.(open.model, open.draft)
    if (id) document.getElementById(id)?.focus()
  }, [open.phase, open.model, open.draft, open.dialog])
  // A run disables the page and the field that had focus, which drops focus to the body. When it ends, focus comes back: to the
  // password after the server's policy refused it (it must be retyped), else to the dialog, so Enter and Escape work again.
  const wasBusy = useRef(false)
  useEffect(() => {
    if (busy) { wasBusy.current = true; return }
    if (!wasBusy.current) return
    wasBusy.current = false
    const active = document.activeElement
    if (active && active !== document.body && form.current?.contains(active)) return
    const password = open.error?.code === 'PASSWORD_POLICY' ? form.current?.querySelector<HTMLInputElement>('.object-dialog-page:not([hidden]) input[type="password"]:not(:disabled)') : null
    if (password) { password.focus(); password.select() } else form.current?.focus()
  }, [busy, open.error])
  const pageKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const next = pageForKey(pages, open.page, event.key, tabs)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    dialogs.setPage(next)
    queueMicrotask(() => nav.current?.querySelector<HTMLElement>(`[data-page="${next}"]`)?.focus())
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
  const mounted = framePages(pages, open.page, visited)
  return <div className="modal-backdrop"><form ref={form} className={'connection-modal object-dialog' + (spec.size === 'large' ? ' large' : '') + (tabs ? ' narrow' : '')} role="dialog" aria-modal="true" aria-labelledby="object-dialog-title" noValidate tabIndex={-1}
    onSubmit={event => { event.preventDefault(); void dialogs.ok() }} onKeyDown={keyDown}>
    <div className="connection-heading"><h2 id="object-dialog-title">{title}</h2>
      <button type="button" className="icon-button" aria-label={'Close ' + title} disabled={executing} onClick={close}><Icon name="close" /></button></div>
    <div className="object-dialog-body">
      <div className="object-dialog-side">
        <PageList pages={pages} current={open.page} tabs={tabs} rendered={new Set(mounted.map(({ page }) => page.id))} onPage={page => dialogs.setPage(page)} onKeyDown={pageKeyDown} navRef={nav} />
        <section className="object-dialog-box" aria-labelledby="object-dialog-connection">
          <div className="object-dialog-caption" id="object-dialog-connection">Connection</div>
          <dl><dt>Server:</dt><dd>{displayText(open.server)}</dd><dt>Connection:</dt><dd>{open.login ? displayText(open.login) : '—'}</dd></dl>
        </section>
        <section className="object-dialog-box" aria-labelledby="object-dialog-progress">
          <div className="object-dialog-caption" id="object-dialog-progress">Progress</div>
          <div className="object-dialog-progress" role="status">{busy && <Icon name="loading" className="object-dialog-spinner" />}{progress}</div>
        </section>
      </div>
      <div className="object-dialog-main">
        <div className="object-dialog-toolbar"><ScriptButton disabled={!scriptAvailable(open.phase, usable)} onScript={destination => void dialogs.script(destination)} /></div>
        {open.error && <div className={'object-dialog-message' + (open.phase === 'stopped' ? ' info' : '')} role={open.phase === 'stopped' ? 'status' : 'alert'}>
          <Icon name={open.phase === 'stopped' ? 'info' : 'error'} /><span>{open.error.message}</span></div>}
        {executing && open.refusal && <div className="object-dialog-message" role="alert"><Icon name="error" /><span>{open.refusal}</span></div>}
        {!open.error && open.notice && <div className="object-dialog-message info" role="status"><Icon name="info" /><span>{open.notice}</span></div>}
        {spec.steps && open.steps && <StepsPanel steps={open.steps} />}
        {mounted.map(({ page, shown }) => {
          const Page = components[page.id]
          return <div key={page.id} className="object-dialog-page" hidden={!shown} {...tabs ? { role: 'tabpanel', id: pagePanelId(page.id), 'aria-labelledby': pageTabId(page.id) } : {}}>
            {Page && <Page open={open} editable={usable && !busy} />}</div>
        })}
      </div>
    </div>
    <div className="connection-footer">
      <span className="object-dialog-blocked" id="object-dialog-blocked">{!busy && blocked}</span>
      <DialogButtons phase={open.phase} busy={busy} blocked={blocked} closeRef={closeButton} stopRef={stopButton} onClose={close} onStop={() => dialogs.stop()} okLabel={okLabel} />
    </div>
  </form></div>
}

interface DialogButtonsProps {
  readonly phase: DialogPhase
  readonly busy: boolean
  readonly blocked: string | undefined
  /** OK's label when the definition names one (Unlock's "Continue in Login Properties…"). */
  readonly okLabel?: string
  readonly closeRef: Ref<HTMLButtonElement>
  readonly stopRef: Ref<HTMLButtonElement>
  onClose(): void
  onStop(): void
}
/**
 * OK and Cancel, Stop while a run executes, or only Close once a dialog that stays open has succeeded. Stop and Cancel are
 * different elements (their keys): focus the run moved to Stop then drops as Stop goes, and the run's end puts it back on the
 * password the server's policy refused, or on the dialog, instead of staying on a reused button that now says Cancel.
 */
export function DialogButtons({ phase, busy, blocked, okLabel = 'OK', closeRef, stopRef, onClose, onStop }: DialogButtonsProps) {
  if (phase === 'succeeded') return <button key="close" ref={closeRef} className="primary" type="button" onClick={onClose}>Close</button>
  return <>
    <button key="ok" className="primary" type="submit" aria-describedby={blocked && !busy ? 'object-dialog-blocked' : undefined}
      disabled={busy || !!blocked || phase === 'loadFailed' || phase === 'disconnected'}>{okLabel}</button>
    {phase === 'executing'
      ? <button key="stop" ref={stopRef} type="button" onClick={onStop}>Stop</button>
      : <button key="cancel" type="button" onClick={onClose}>{phase === 'disconnected' ? 'Close' : 'Cancel'}</button>}
  </>
}
