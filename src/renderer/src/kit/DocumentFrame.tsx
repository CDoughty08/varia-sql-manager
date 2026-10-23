import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { commandDescriptor } from '../../../shared/commands/catalog'
import { nextFrame } from '../core/frame'
import type { CommandArgs, CommandId } from '../core/types'
import { useCommandsEnabled, useCommandsToggled } from '../core/useCommand'
import { useWorkbench } from '../core/WorkbenchContext'
import { revealBy, scrolledTo, sectionKey, sectionLabel, selectSection, setScriptOpen, spySection, toggleSection, resizeScript, verbTooltip, type FrameState, type SectionInfo } from './document-frame'
import ScriptDrawer, { type ScriptDrawerProps } from './ScriptDrawer'

/** One step of the path to the document's object: the server (connection), a folder, a database. Its tooltip is `title`, or the label, which may be cut. */
export interface Crumb { readonly label: string; readonly title?: string }
/** A fact in the line under the header ("Folder Warehouse", "Started 22:41:07 +01:00"). */
export interface Fact { readonly label: string; readonly value: string; readonly title?: string }
/**
 * A header button, always a catalogue command, so the palette, menus and keys offer the same verb. `primary` is the
 * document's one filled button (Save, Execute); `danger` is outlined in the error colour (Stop execution, Kill session…).
 */
export interface Verb {
  readonly command: CommandId
  readonly args?: CommandArgs
  /** The words on the button; the command's catalogue title by default. */
  readonly label?: string
  readonly icon?: string
  readonly emphasis?: 'primary' | 'danger'
}
/**
 * A verb as the header draws it, with its state and its key worked out. `pressed` is set for a command with a `toggled`
 * condition (Split View), whose button then says whether it is on (`aria-pressed`).
 */
export interface HeaderVerb { readonly key: string; readonly label: string; readonly title: string; readonly icon?: string; readonly emphasis?: Verb['emphasis']; readonly disabled: boolean; readonly pressed?: boolean; readonly run: () => void }
export interface FrameSection extends SectionInfo {
  readonly content: ReactNode
  /** Its heading opens and closes it; a collapsed section's content is not rendered. */
  readonly collapsible?: boolean
  /** Beside the heading: a count, a StaleBadge, a section's own actions. */
  readonly aside?: ReactNode
}

interface HeaderProps {
  readonly id: string
  readonly title: string
  readonly crumbs?: readonly Crumb[]
  /** Muted words after the title ("Execution 48213"). */
  readonly subtitle?: string
  /** A StatusPill or LivePill: what the document is doing. */
  readonly state?: ReactNode
  /** Document controls before the verbs: a segmented control, an interval picker, an overflow button. */
  readonly tools?: ReactNode
  readonly verbs?: readonly HeaderVerb[]
}

/** The header row: where the object is (connection and path), its name, its state, then its controls and verbs. */
export function DocumentHeader({ id, title, crumbs = [], subtitle, state, tools, verbs = [] }: HeaderProps) {
  // Only the first primary verb is filled, so a document never offers two equal calls to action.
  const primary = verbs.findIndex(verb => verb.emphasis === 'primary')
  return <header className="document-header">
    <div className="document-heading">
      {crumbs.length > 0 && <nav className="document-crumbs" aria-label="Location">
        <ol>{crumbs.map((crumb, index) => <li key={index} title={crumb.title ?? crumb.label}>
          <span className="document-crumb">{crumb.label}</span><span className="codicon codicon-chevron-right" aria-hidden="true" />
        </li>)}</ol>
      </nav>}
      <h1 className="document-title" id={`${id}-title`}>{title}</h1>
      {subtitle && <span className="document-subtitle">{subtitle}</span>}
      {state}
    </div>
    {(tools || verbs.length > 0) && <div className="document-actions" role="group" aria-label={`${title} actions`}>
      {tools}
      {verbs.map((verb, index) => <button key={verb.key} type="button" className={index === primary ? 'document-verb primary' : verb.emphasis === 'danger' ? 'document-verb danger' : 'document-verb'}
        title={verb.title} aria-pressed={verb.pressed} disabled={verb.disabled} onClick={verb.run}>
        {verb.icon && <span className={`codicon codicon-${verb.icon}`} aria-hidden="true" />}{verb.label}
      </button>)}
    </div>}
  </header>
}

/** The fact line under the header, label and value pairs that wrap. */
export function FactLine({ facts }: { readonly facts: readonly Fact[] }) {
  return <dl className="document-facts">
    {facts.map((fact, index) => <div key={index} title={fact.title}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
  </dl>
}

interface NavProps {
  readonly id: string
  readonly sections: readonly SectionInfo[]
  readonly current: string
  readonly onChoose: (id: string) => void
}

/**
 * The section list beside the content: each section is a button, the current one marked (`aria-current`). The list is
 * one tab stop, on the current section; the keys move from the focused one, wherever the scroll has taken the current.
 */
export function SectionNav({ id, sections, current, onChoose }: NavProps) {
  const nav = useRef<HTMLElement>(null)
  const item = (section: string) => nav.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(section)}"]`)
  // The list follows the scroll, so the current section stays in view where the list is longer than its box.
  useLayoutEffect(() => {
    const list = nav.current, marked = item(current)
    if (!list || !marked) return
    const view = list.getBoundingClientRect(), box = marked.getBoundingClientRect()
    const top = view.top + list.clientTop, left = view.left + list.clientLeft
    list.scrollTop += revealBy(box.top, box.bottom, top, top + list.clientHeight)
    list.scrollLeft += revealBy(box.left, box.right, left, left + list.clientWidth)
  }, [current])
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-section]')?.dataset.section ?? current
    const next = sectionKey(event.key, sections.map(section => section.id), from)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (next !== from || next !== current) onChoose(next)
    // The layout effect above shows it inside the list; focus alone would scroll whatever holds the document too.
    item(next)?.focus({ preventScroll: true })
  }
  const stop = sections.some(section => section.id === current) ? current : sections[0]?.id
  return <nav ref={nav} className="document-nav" aria-label="Sections" onKeyDown={keyDown}>
    {sections.map(section => <button key={section.id} type="button" className="document-nav-item" data-section={section.id} tabIndex={section.id === stop ? 0 : -1} aria-current={section.id === current ? 'location' : undefined}
      aria-label={section.problem ? sectionLabel(section) : undefined} aria-controls={sectionDomId(id, section.id)} onClick={() => onChoose(section.id)}>
      <span className="document-nav-title">{section.title}</span>
      {section.problem && <span className="codicon codicon-error" aria-hidden="true" />}
    </button>)}
  </nav>
}

const sectionDomId = (id: string, section: string) => `${id}-section-${section}`

/** A section of the content: its heading (a disclosure button when it collapses), what sits beside it, and its body. */
export function FrameSectionView({ id, section, collapsed, onToggle }: { readonly id: string; readonly section: FrameSection; readonly collapsed: boolean; readonly onToggle: () => void }) {
  const domId = sectionDomId(id, section.id), headingId = `${domId}-heading`, bodyId = `${domId}-body`
  const open = !section.collapsible || !collapsed
  return <section className="document-section" id={domId} aria-labelledby={headingId} data-section={section.id}>
    <div className="document-section-head">
      <h2 className="document-section-title" id={headingId}>
        {section.collapsible
          ? <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}><span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />{section.title}</button>
          : section.title}
      </h2>
      {section.aside}
    </div>
    {open && <div className="document-section-body" id={bodyId}>{section.content}</div>}
  </section>
}

export interface DocumentFrameViewProps extends Omit<HeaderProps, 'verbs'> {
  readonly verbs?: readonly HeaderVerb[]
  readonly facts?: readonly Fact[]
  /** Above the content: what the document needs said before its sections (an InlineError, a note that it is out of date). */
  readonly notice?: ReactNode
  /** Sections with a list beside them; without them the frame shows `children` under the header. */
  readonly sections?: readonly FrameSection[]
  readonly children?: ReactNode
  /** The document's frame state (its service keeps it); needed with sections or a Script drawer. */
  readonly frame?: FrameState
  readonly onFrame?: (next: FrameState) => void
  readonly script?: Omit<ScriptDrawerProps, 'id' | 'open' | 'size' | 'onToggle' | 'onResize'>
  /** Marks the document for focus facts and menus (`data-designer`, say); the frame adds `data-document-frame`. */
  readonly attributes?: Readonly<Record<`data-${string}`, string>>
}

/**
 * Every non-query document's chrome (Activity Monitor, SSIS documents, properties as documents): the header row, an
 * optional fact line, the content (one scrolling column of sections with their list on the left, or the document's
 * own body), and an optional Script drawer under it. It holds no state of its own: `frame` comes from the document's
 * service, and every change goes back through `onFrame`.
 */
export function DocumentFrameView(props: DocumentFrameViewProps) {
  const { id, title, crumbs, subtitle, state, tools, verbs, facts = [], notice, sections, children, frame, onFrame, script, attributes } = props
  const change = onFrame ?? (() => {})
  return <div className="document-frame" role="region" aria-labelledby={`${id}-title`} data-document-frame={id} {...attributes}>
    <DocumentHeader id={id} title={title} crumbs={crumbs} subtitle={subtitle} state={state} tools={tools} verbs={verbs} />
    {facts.length > 0 && <FactLine facts={facts} />}
    {notice && <div className="document-notice">{notice}</div>}
    {sections && frame ? <SectionedBody id={id} sections={sections} frame={frame} onFrame={change} /> : <div className="document-content">{children}</div>}
    {script && frame && <ScriptDrawer id={id} open={frame.scriptOpen} size={frame.scriptSize} {...script}
      onToggle={() => change(setScriptOpen(frame, !frame.scriptOpen))} onResize={size => change(resizeScript(frame, size))} />}
  </div>
}

/**
 * The sections in one scrolling column. Choosing one in the list scrolls its heading to the top; scrolling marks the
 * section in view, checked once a frame. Near the end, where the last sections cannot reach the top, the one chosen
 * stays marked (`spySection`).
 */
function SectionedBody({ id, sections, frame, onFrame }: { readonly id: string; readonly sections: readonly FrameSection[]; readonly frame: FrameState; readonly onFrame: (next: FrameState) => void }) {
  const content = useRef<HTMLDivElement>(null)
  // The latest frame and handler for the scroll callback, which runs a frame after the render that set it up.
  const latest = useRef({ frame, onFrame, sections })
  latest.current = { frame, onFrame, sections }
  const chosen = useRef<string | undefined>(undefined)
  const reveal = useRef<string | undefined>(undefined)
  const pending = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => pending.current?.(), [])
  // After a choice has rendered (a collapsed section opens first), its heading goes to the top of the column.
  useLayoutEffect(() => {
    const target = reveal.current, column = content.current
    if (!target || !column) return
    reveal.current = undefined
    const element = column.querySelector<HTMLElement>(`#${CSS.escape(sectionDomId(id, target))}`)
    if (element) column.scrollTop = element.offsetTop
  })
  const choose = (section: string) => {
    chosen.current = section
    const element = content.current?.querySelector<HTMLElement>(`#${CSS.escape(sectionDomId(id, section))}`)
    // An open section scrolls now; a collapsed one once it has opened (the render that opens it runs the effect above).
    if (element && content.current && !frame.collapsed.includes(section)) content.current.scrollTop = element.offsetTop
    else reveal.current = section
    onFrame(selectSection(frame, sections, section))
  }
  const scrolled = () => {
    pending.current?.()
    pending.current = nextFrame(() => {
      pending.current = undefined
      const column = content.current
      if (!column) return
      const { frame, onFrame, sections } = latest.current
      const tops = sections.map(section => column.querySelector<HTMLElement>(`#${CSS.escape(sectionDomId(id, section.id))}`)?.offsetTop ?? 0)
      const chosenIndex = chosen.current === undefined ? undefined : sections.findIndex(section => section.id === chosen.current)
      const index = spySection(tops, column, chosenIndex)
      // Away from the end the scroll decides, so a later choice is needed to pin a section again.
      if (column.scrollTop + column.clientHeight < column.scrollHeight - 1) chosen.current = undefined
      if (index >= 0) onFrame(scrolledTo(frame, sections[index].id))
    })
  }
  return <div className="document-body">
    {sections.length > 1 && <SectionNav id={id} sections={sections} current={frame.section} onChoose={choose} />}
    <div className="document-content document-sections" ref={content} onScroll={scrolled}>
      {sections.map(section => <FrameSectionView key={section.id} id={id} section={section} collapsed={frame.collapsed.includes(section.id)} onToggle={() => onFrame(toggleSection(frame, section.id))} />)}
    </div>
  </div>
}

/**
 * Header verbs from catalogue commands: the catalogue's title and icon unless the document names its own, whether each
 * can run now, its key in the tooltip, and running it as the toolbar does.
 */
export function headerVerbs(verbs: readonly Verb[], enabled: readonly boolean[], toggled: readonly boolean[], keyOf: (id: CommandId) => { readonly text: string } | undefined, execute: (id: CommandId, args: CommandArgs | undefined) => void): HeaderVerb[] {
  return verbs.map((verb, index) => {
    const descriptor = commandDescriptor(verb.command), label = verb.label ?? descriptor.title
    return {
      key: `${verb.command}-${index}`, label, title: verbTooltip(label, keyOf(verb.command)), icon: verb.icon ?? descriptor.icon, emphasis: verb.emphasis,
      disabled: !enabled[index], ...(descriptor.toggled === undefined ? {} : { pressed: !!toggled[index] }), run: () => execute(verb.command, verb.args)
    }
  })
}

/** `headerVerbs` for a rendered header, kept current as commands become available and toggles change. */
export function useHeaderVerbs(verbs: readonly Verb[]): readonly HeaderVerb[] {
  const workbench = useWorkbench()
  const enabled = useCommandsEnabled(verbs.map(verb => ({ id: verb.command, args: verb.args })))
  const toggled = useCommandsToggled(verbs.map(verb => verb.command))
  return headerVerbs(verbs, enabled, toggled, id => workbench.keybindings.lookup(id), (id, args) => void workbench.commands.execute(id, args, 'toolbar'))
}

export interface DocumentFrameProps extends Omit<DocumentFrameViewProps, 'verbs'> { readonly verbs?: readonly Verb[] }

/** The document frame with its verbs taken from the command catalogue. */
export default function DocumentFrame({ verbs = [], ...props }: DocumentFrameProps) {
  return <DocumentFrameView {...props} verbs={useHeaderVerbs(verbs)} />
}
