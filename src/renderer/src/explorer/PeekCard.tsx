import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { kindSpecs } from '../../../shared/explorer/catalog.ts'
import { peekSpecs } from '../../../shared/explorer/peek.ts'
import { displayText } from '../../../shared/explorer/refs.ts'
import { scriptCommandId } from '../../../shared/scripting/catalog.ts'
import { isSqlScope } from '../../../shared/theme/registry'
import type { SyntaxStyle } from '../../../shared/theme/types'
import { useServiceSnapshot, useWorkbench } from '../core/WorkbenchContext'
import { onUnexpectedError } from '../core/errors'
import Icon from '../Icon'
import ExplorerIcon from './ExplorerIcon'
import { formatPeekValue, placePeek } from './peek-format'
import { peekMessages, type OpenPeek, type PeekPart } from './PeekService'

/** Lines of a definition that are coloured; longer text shows the rest plain, so a huge module never stalls the card. */
const colouredLines = 3000

/** A run of definition text in one SQL scope's colour. */
interface Run { readonly text: string; readonly style?: SyntaxStyle }

/**
 * Monaco's SQL tokens for the first `colouredLines` lines, merged into runs; the rest of the text is one plain run. SQL's
 * tokenizer loads lazily (start.tsx registers it), and tokenize answers plain text until it has: colorize waits for it,
 * and the runs are made again once it is there.
 */
function useRuns(text: string | undefined): readonly Run[] {
  const { monaco, theme } = useWorkbench()
  const { active } = useServiceSnapshot(theme)
  const [sqlLoaded, setSqlLoaded] = useState(false)
  useEffect(() => {
    let live = true
    monaco.editor.colorize('', 'sql', {}).then(() => { if (live) setSqlLoaded(true) }, onUnexpectedError)
    return () => { live = false }
  }, [monaco])
  return useMemo(() => {
    if (text === undefined) return []
    try {
      const lines = text.split('\n')
      const head = lines.slice(0, colouredLines), tokens = monaco.editor.tokenize(head.join('\n'), 'sql')
      const runs: Run[] = []
      const push = (piece: string, style?: SyntaxStyle) => {
        const last = runs[runs.length - 1]
        if (last && last.style === style) runs[runs.length - 1] = { text: last.text + piece, ...(style ? { style } : {}) }
        else runs.push({ text: piece, ...(style ? { style } : {}) })
      }
      head.forEach((line, index) => {
        const lineTokens = tokens[index] ?? []
        lineTokens.forEach((token, at) => {
          const end = lineTokens[at + 1]?.offset ?? line.length
          const scope = token.type.replace(/\.sql$/, '')
          push(line.slice(token.offset, end), isSqlScope(scope) ? active.syntax[scope] : undefined)
        })
        if (!lineTokens.length) push(line)
        if (index < lines.length - 1) push('\n')
      })
      if (lines.length > colouredLines) push(lines.slice(colouredLines).join('\n'))
      return runs
    } catch (error) {
      onUnexpectedError(error)
      return [{ text }]
    }
  }, [text, monaco, active, sqlLoaded])
}

function Definition({ part }: { part: PeekPart<{ readonly text?: string; readonly truncated?: boolean }> }) {
  const text = part.status === 'ready' ? part.value.text : undefined
  const runs = useRuns(text)
  if (part.status === 'loading') return <p className="peek-note" role="status">Loading the definition…</p>
  if (part.status === 'error') return <p className="peek-note error" role="alert">{part.message}</p>
  if (text === undefined) return <p className="peek-note">{peekMessages.noDefinition}</p>
  return <>
    <pre className="peek-definition" tabIndex={0} aria-label="Definition">{runs.map((run, index) => run.style
      ? <span key={index} style={{ color: run.style.foreground, fontStyle: run.style.fontStyle.includes('italic') ? 'italic' : undefined, fontWeight: run.style.fontStyle.includes('bold') ? 'bold' : undefined }}>{run.text}</span>
      : run.text)}</pre>
    {part.value.truncated && <p className="peek-note">The definition is longer than the card shows. Script it to see all of it.</p>}
  </>
}

function Properties({ peek }: { peek: OpenPeek }) {
  const { facts } = peek
  if (facts.status === 'loading') return <p className="peek-note" role="status">Loading properties…</p>
  if (facts.status === 'error') return <p className="peek-note error" role="alert">{facts.message}</p>
  return <div className="peek-properties">
    {peekSpecs[peek.kind].groups.map(group => {
      const shown = group.facts.filter(fact => Object.hasOwn(facts.value, fact.id))
      return shown.length > 0 && <section key={group.id} aria-label={group.title}>
        <h3 className="peek-group">{group.title}</h3>
        <dl className="peek-facts">{shown.map(fact => <div key={fact.id} className="peek-fact"><dt>{fact.label}</dt><dd title={formatPeekValue(fact, facts.value[fact.id])}>{formatPeekValue(fact, facts.value[fact.id])}</dd></div>)}</dl>
      </section>
    })}
  </div>
}

function PaneTitle({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="peek-pane-title"><span>{title}</span><span className="peek-spacer" />{children}</div>
}

/**
 * The Peek card: the object's definition on the left, its properties on the right, floating beside Object Explorer in the
 * window the pane is in (docs/popout-windows.md), so it is drawn into that window's body. Esc, a click outside it or
 * another peek closes it; a peek from the keyboard or the menu focuses it, a hover does not.
 */
export default function PeekCard() {
  const { peek: service, commands } = useWorkbench()
  const { open } = useServiceSnapshot(service)
  const anchor = useRef<HTMLSpanElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<ReturnType<typeof placePeek> | undefined>(undefined)
  const doc = anchor.current?.ownerDocument

  // Placed again as the tree scrolls or the window resizes; a row scrolled out of the window keeps the card where it was.
  useLayoutEffect(() => {
    const here = anchor.current
    if (!open || !here) { setPlace(undefined); return }
    const view = here.ownerDocument.defaultView, tree = here.ownerDocument.querySelector<HTMLElement>('[data-explorer-tree]')
    if (!view) return
    let frame = 0
    const measure = () => {
      frame = 0
      const pane = (tree ?? here).getBoundingClientRect(), row = here.ownerDocument.getElementById(`oe-${open.rowId}`)?.getBoundingClientRect()
      setPlace(last => placePeek(row && row.bottom > pane.top && row.top < pane.bottom ? row : undefined, pane, { width: view.innerWidth, height: view.innerHeight }, last))
    }
    const schedule = () => { if (!frame) frame = view.requestAnimationFrame(measure) }
    measure()
    tree?.addEventListener('scroll', schedule, { passive: true })
    view.addEventListener('resize', schedule)
    return () => { if (frame) view.cancelAnimationFrame(frame); tree?.removeEventListener('scroll', schedule); view.removeEventListener('resize', schedule) }
  }, [open?.id, open?.rowId])

  // The keyboard and the menu move focus into the card (once per peek), so Esc and screen readers reach it.
  const focused = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!open || open.source === 'hover' || focused.current === open.id || !place) return
    focused.current = open.id
    card.current?.focus({ preventScroll: true })
  }, [open?.id, open?.source, place])

  // A press outside the card closes it; a press on a row then selects that row as usual.
  useEffect(() => {
    if (!open || !doc) return
    const press = (event: PointerEvent) => { if (!card.current?.contains(event.target as Node)) service.close() }
    doc.addEventListener('pointerdown', press, true)
    return () => doc.removeEventListener('pointerdown', press, true)
  }, [open?.id, doc, service])

  const close = (refocus: boolean) => {
    const tree = card.current?.ownerDocument.querySelector<HTMLElement>('[data-explorer-tree]')
    service.close()
    if (refocus) tree?.focus({ preventScroll: true })
  }
  // Tab stays within the card, so Esc keeps reaching it; Esc or Close returns to the tree.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key !== 'Tab' || !card.current) return
    const stops = [...card.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')]
    const first = stops[0], last = stops[stops.length - 1], at = card.current.ownerDocument.activeElement
    if (!first || !last) { event.preventDefault(); return }
    if (event.shiftKey && (at === first || at === card.current)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && at === last) { event.preventDefault(); first.focus() }
  }
  const node = open?.node
  const object = node?.ref.type === 'object' ? node.ref.object : undefined
  const name = object ? displayText(object.schema === undefined ? object.name ?? '' : `${object.schema}.${object.name ?? ''}`) : ''
  const definition = open?.definition.status === 'ready' ? open.definition.value : undefined
  const copyable = definition?.text !== undefined && !definition.truncated
  const script = scriptCommandId('create', 'newQuery')
  return <span ref={anchor} className="peek-anchor" hidden>
    {open && node && place && doc && createPortal(
      <div ref={card} className="peek-card" role="dialog" aria-modal="false" aria-label={`Peek: ${name}`} tabIndex={-1} onKeyDown={keyDown} data-peek-source={open.source}
        style={{ left: place.left, top: place.top, width: place.width, height: place.height }}>
        <div className="peek-head">
          <ExplorerIcon name={kindSpecs[open.kind].icon} />
          <bdi className="peek-name" title={name}>{name}</bdi>
          <span className="peek-kind">{kindSpecs[open.kind].title}</span>
          <span className="peek-spacer" />
          <button type="button" className="icon-button" aria-label="Refresh" title="Refresh" onClick={() => service.refresh()}><Icon name="refresh" /></button>
          <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={() => close(true)}><Icon name="close" /></button>
        </div>
        <div className="peek-body">
          <div className="peek-pane">
            <PaneTitle title="Definition">
              <button type="button" className="peek-action" disabled={!copyable} title={definition?.truncated ? 'The definition is cut; Script to New Query has all of it.' : undefined} onClick={() => { service.copyDefinition().catch(onUnexpectedError) }}>Copy</button>
              <button type="button" className="peek-action" disabled={!commands.isEnabled(script, { target: { kind: 'explorer', node } })}
                onClick={() => { const target = { target: { kind: 'explorer' as const, node } }; close(false); void commands.execute(script, target, 'toolbar') }}>Script to New Query</button>
            </PaneTitle>
            <div className="peek-scroll"><Definition part={open.definition} /></div>
          </div>
          <div className="peek-pane peek-side">
            <PaneTitle title="Properties" />
            <div className="peek-scroll"><Properties peek={open} /></div>
          </div>
        </div>
      </div>, doc.body)}
  </span>
}
