import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { environmentTag } from '../../../shared/environments'
import { useConnectionAccent } from '../core/WorkbenchContext'
import EnvironmentTag from '../EnvironmentTag'
import Icon from '../Icon'
import type { LiveConnection } from '../services/connections'
import { serverGroups, type SearchDocumentState } from './ObjectSearchService'

/** The picker's value for All servers. */
export const allServersValue = '*'
const numbers = new Intl.NumberFormat('en-US')
/** How long typed letters add up to one type-ahead prefix, as a native select's do. */
const typeAheadMs = 500

/** One choice in the Search Objects tab's server picker: a server, or All servers. */
export interface ServerOption {
  /** The server's connection id, or `allServersValue`. */
  readonly value: string
  readonly label: string
  readonly color?: string
  readonly environment?: string
  /** Its results for the tab's current search, when the tab has them: a server's from its group (All servers) or from the
   *  tab's own answer (that server alone), All servers' total from the merged answer. Never asked for on its own. */
  readonly count?: number
  /** Its answer to the current search is still on its way. */
  readonly pending?: boolean
}

/**
 * The picker's options: All servers, then every connected server in Object Explorer's order, each with its colour, environment
 * and its result count for the tab's current search, read from the answers the tab already has (no request of its own).
 */
export function serverPickerOptions(state: SearchDocumentState, live: readonly LiveConnection[]): ServerOption[] {
  const answered = !!state.result && !!state.asked?.text.trim()
  const groups = state.allServers && answered ? serverGroups(state) : []
  const countFor = (connectionId: string): Pick<ServerOption, 'count' | 'pending'> => {
    if (!answered) return {}
    if (!state.allServers) return connectionId === state.connectionId && !state.result!.problem ? { count: state.result!.total } : {}
    const group = groups.find(item => item.connectionId === connectionId)
    if (!group) return {}
    return { ...group.result && !group.result.problem && !group.error ? { count: group.result.total } : {}, ...group.pending ? { pending: true } : {} }
  }
  const all: ServerOption = {
    value: allServersValue, label: 'All servers',
    ...state.allServers && answered && !state.result!.problem ? { count: state.result!.total } : {}, ...state.allServers && state.requestId ? { pending: true } : {}
  }
  return [all, ...live.map(connection => ({
    value: connection.id, label: connection.displayName || connection.server, ...connection.color ? { color: connection.color } : {},
    ...connection.options.environment ? { environment: connection.options.environment } : {}, ...countFor(connection.id)
  }))]
}

/** What a screen reader hears for an option: its name, environment and results, as the row shows them. */
export function serverOptionName(option: ServerOption): string {
  const environment = environmentTag(option.environment)?.description
  const results = option.count === undefined ? undefined : `${numbers.format(option.count)} result${option.count === 1 ? '' : 's'}`
  return [option.label, environment, results, option.pending ? 'searching' : undefined].filter(Boolean).join(', ')
}

/** The option a type-ahead prefix reaches: the next one after `from` whose name starts with it (one letter typed again cycles). */
export function typeAheadMatch(options: readonly ServerOption[], prefix: string, from: number): number | undefined {
  const lower = prefix.toLowerCase(), cycling = [...lower].every(letter => letter === lower[0])
  const start = cycling ? from + 1 : from
  for (let step = 0; step < options.length; step++) {
    const index = (start + step) % options.length, label = options[index]!.label.toLowerCase()
    if (label.startsWith(lower) || (cycling && label.startsWith(lower[0]!))) return index
  }
  return undefined
}

function Mark({ option }: { readonly option: ServerOption }) {
  const accent = useConnectionAccent(option.color)
  if (option.value === allServersValue) return <Icon name="layers" />
  return <span className="object-search-group-dot" aria-hidden="true" style={{ background: accent ?? 'var(--varia-connection-default)' }} />
}

function OptionBody({ option, counts }: { readonly option: ServerOption; readonly counts: boolean }) {
  return <>
    <Mark option={option} />
    <bdi className="object-search-server-name">{option.label}</bdi>
    <EnvironmentTag environment={option.environment} place="list" />
    {counts && <span className="object-search-server-count">{option.count === undefined ? (option.pending ? '…' : '') : numbers.format(option.count)}</span>}
  </>
}

interface Props {
  readonly id: string
  readonly labelledBy: string
  readonly options: readonly ServerOption[]
  readonly value: string
  readonly onChange: (value: string) => void
}

/**
 * The Search Objects tab's server picker: a select-only combobox (WAI-ARIA's pattern) whose listbox opens in Chromium's top
 * layer, outside the tab's clipping, themed as Varia's menus are. Focus stays on the combobox and the active option is its
 * aria-activedescendant. Closed: ↓, ↑, Enter, Space and Alt+↓ open it, Home and End open it on the first or last option, and
 * letters open it on the option they spell. Open: ↑ ↓ Home End and letters move, Enter, Space and Alt+↑ choose, Tab chooses
 * and moves on, Escape closes without choosing; a click outside closes it.
 */
export default function ServerPicker({ id, labelledBy, options, value, onChange }: Props) {
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: '', at: 0 })
  const [active, setActive] = useState<number | undefined>(undefined)
  const open = active !== undefined
  const selected = Math.max(0, options.findIndex(option => option.value === value))
  const listId = `${id}-servers`, optionId = (index: number) => `${listId}-${index}`
  const place = () => {
    const invoker = button.current, popover = panel.current
    if (!invoker || !popover) return
    const box = invoker.getBoundingClientRect(), viewport = document.documentElement, inset = 8, gap = 2
    if (!box.width) { close(); return }
    popover.style.minWidth = `${box.width}px`
    popover.style.maxWidth = `${Math.max(box.width, viewport.clientWidth - inset * 2)}px`
    const width = popover.offsetWidth
    popover.style.left = `${Math.max(inset, Math.min(box.left, viewport.clientWidth - width - inset))}px`
    const below = Math.max(0, viewport.clientHeight - box.bottom - gap - inset), above = Math.max(0, box.top - gap - inset)
    const up = popover.scrollHeight > below && above > below
    popover.style.maxHeight = `${up ? above : below}px`
    popover.style.top = `${up ? Math.max(inset, box.top - gap - Math.min(popover.scrollHeight + 2, above)) : box.bottom + gap}px`
  }
  const show = (index: number) => {
    const popover = panel.current
    if (popover && !popover.matches(':popover-open')) popover.showPopover()
    setActive(Math.max(0, Math.min(index, options.length - 1)))
  }
  function close() {
    const popover = panel.current
    if (popover?.matches(':popover-open')) popover.hidePopover()
    setActive(undefined)
  }
  const choose = (index: number) => {
    close()
    const option = options[index]
    if (option && option.value !== value) onChange(option.value)
  }
  useLayoutEffect(() => {
    if (!open) return
    place()
    const observer = new ResizeObserver(place)
    if (button.current) observer.observe(button.current)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open])
  useLayoutEffect(() => {
    if (active !== undefined) panel.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  // Options can change while the list is open (a server connects or leaves); the active one stays in range.
  useLayoutEffect(() => { if (active !== undefined && active >= options.length) setActive(options.length - 1) }, [options.length])
  const typeAhead = (key: string, from: number) => {
    const now = performance.now(), state = typed.current
    state.text = now - state.at > typeAheadMs ? key : state.text + key
    state.at = now
    return typeAheadMatch(options, state.text, from)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return
    const last = options.length - 1, key = event.key
    const letter = key.length === 1 && key !== ' ' && !event.altKey ? key : undefined
    const typing = typed.current.text !== '' && performance.now() - typed.current.at <= typeAheadMs
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') show(selected)
      else if (key === 'Home') show(0)
      else if (key === 'End') show(last)
      else if (letter) { const match = typeAhead(letter, selected); show(match ?? selected) }
      else return
    } else {
      const at = active ?? selected
      if (event.altKey && key === 'ArrowUp') choose(at)
      else if (key === 'ArrowDown') setActive(Math.min(last, at + 1))
      else if (key === 'ArrowUp') setActive(Math.max(0, at - 1))
      else if (key === 'Home' || key === 'PageUp') setActive(0)
      else if (key === 'End' || key === 'PageDown') setActive(last)
      else if (key === 'Enter' || (key === ' ' && !typing)) choose(at)
      else if (key === 'Escape') close()
      else if (key === 'Tab') { choose(at); return }
      else if (letter || key === ' ') { const match = typeAhead(key, at); if (match !== undefined) setActive(match) }
      else return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  const current = options[selected]
  return <>
    <button ref={button} type="button" role="combobox" id={id} className="object-search-server-button" aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={listId} aria-activedescendant={active !== undefined ? optionId(active) : undefined} title={current ? serverOptionName(current) : undefined}
      onClick={() => { if (open) close(); else show(selected) }} onKeyDown={onKeyDown} onBlur={() => { if (open) close() }}>
      {current && <OptionBody option={current} counts={false} />}
      <Icon name="chevron-down" />
    </button>
    <div ref={panel} id={listId} className="object-search-server-list" popover="manual" role="listbox" aria-labelledby={labelledBy}
      // Options take no focus: a press keeps it on the combobox, so choosing never blurs it.
      onPointerDown={event => event.preventDefault()}>
      {options.map((option, index) => <div key={option.value} id={optionId(index)} role="option" className="object-search-server-option" aria-selected={index === selected}
        aria-label={serverOptionName(option)} data-active={index === active ? '' : undefined} onPointerMove={() => { if (active !== index) setActive(index) }} onClick={() => choose(index)}>
        <OptionBody option={option} counts />
      </div>)}
    </div>
  </>
}
