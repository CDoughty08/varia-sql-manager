// The document frame's rules without the DOM: which section is current, what the keys do in the section list and on
// the Script drawer's splitter, and how much of a script the drawer draws. A document's service keeps a FrameState per
// open document (tabs remount their view when they switch), so the frame itself holds no state.
import { formatCount } from '../results/status'

export const frameLimits = {
  /** Characters and lines the Script drawer draws; Open in Query Window and Copy always take the whole script. */
  previewCharacters: 200_000,
  previewLines: 5_000,
  /** The drawer's share of the document's height while it is open. */
  scriptMinimum: 0.15,
  scriptMaximum: 0.7,
  scriptDefault: 0.35,
  /** What one arrow key on the splitter moves it by. */
  scriptStep: 0.05,
  /** A heading this close below the top of the view (px) already makes its section the current one. */
  spyOffset: 24
} as const

/** A section as the list names it; `problem` marks one whose fields need attention (a glyph, and words in its name). */
export interface SectionInfo { readonly id: string; readonly title: string; readonly problem?: boolean }

export interface FrameState {
  /** The section the list marks as current: the one chosen, or the one scrolled to. */
  readonly section: string
  /** Collapsed sections, by id; a live document pauses what a collapsed section shows. */
  readonly collapsed: readonly string[]
  readonly scriptOpen: boolean
  /** The open drawer's share of the document's height, within frameLimits. */
  readonly scriptSize: number
}

export function initialFrameState(sections: readonly Pick<SectionInfo, 'id'>[], options: { readonly scriptOpen?: boolean; readonly collapsed?: readonly string[] } = {}): FrameState {
  const ids = new Set(sections.map(section => section.id))
  return { section: sections[0]?.id ?? '', collapsed: (options.collapsed ?? []).filter(id => ids.has(id)), scriptOpen: options.scriptOpen ?? false, scriptSize: frameLimits.scriptDefault }
}

/** Choosing a section makes it current and opens it if it was collapsed, since the list is how people get to it. */
export function selectSection(state: FrameState, sections: readonly Pick<SectionInfo, 'id'>[], id: string): FrameState {
  if (!sections.some(section => section.id === id)) return state
  const collapsed = state.collapsed.includes(id) ? state.collapsed.filter(item => item !== id) : state.collapsed
  return state.section === id && collapsed === state.collapsed ? state : { ...state, section: id, collapsed }
}

/** Scrolling moves the current section without opening anything. */
export function scrolledTo(state: FrameState, id: string): FrameState {
  return state.section === id || !id ? state : { ...state, section: id }
}

export function toggleSection(state: FrameState, id: string): FrameState {
  return { ...state, collapsed: state.collapsed.includes(id) ? state.collapsed.filter(item => item !== id) : [...state.collapsed, id] }
}

export function setScriptOpen(state: FrameState, open: boolean): FrameState {
  return state.scriptOpen === open ? state : { ...state, scriptOpen: open }
}

const clampSize = (size: number) => Number.isFinite(size) ? Math.round(Math.min(frameLimits.scriptMaximum, Math.max(frameLimits.scriptMinimum, size)) * 100) / 100 : frameLimits.scriptDefault

export function resizeScript(state: FrameState, size: number): FrameState {
  const next = clampSize(size)
  return next === state.scriptSize ? state : { ...state, scriptSize: next }
}

/**
 * The drawer's splitter as a window splitter: Up makes the drawer taller and Down shorter, a step at a time; Home and
 * End go to its smallest and largest. Undefined for any other key.
 */
export function scriptSizeKey(size: number, key: string): number | undefined {
  switch (key) {
    case 'ArrowUp': return clampSize(size + frameLimits.scriptStep)
    case 'ArrowDown': return clampSize(size - frameLimits.scriptStep)
    case 'Home': return frameLimits.scriptMinimum
    case 'End': return frameLimits.scriptMaximum
    default: return undefined
  }
}

/**
 * The section list's keys, as SSMS's "Select a page": Down and Up move to the next and previous section without
 * wrapping, Home and End to the first and last. Undefined when the key moves nothing.
 */
export function sectionKey(key: string, ids: readonly string[], current: string): string | undefined {
  const index = ids.indexOf(current)
  const next = key === 'ArrowDown' ? index + 1 : key === 'ArrowUp' ? index - 1 : key === 'Home' ? 0 : key === 'End' ? ids.length - 1 : -1
  return next >= 0 && next < ids.length && next !== index ? ids[next] : undefined
}

export interface ScrollView { readonly scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number }

/**
 * Which section the view shows, from the sections' tops (px from the content's top, in order): the last one whose
 * heading has reached the top of the view. At the end of the scroll the sections below the last such heading can never
 * reach the top, so there the one the person chose stays current while it is in view, and otherwise the last one is.
 * -1 when there are no sections.
 */
export function spySection(tops: readonly number[], view: ScrollView, chosen?: number): number {
  if (!tops.length) return -1
  let reached = 0
  for (let index = 0; index < tops.length; index++) if (tops[index] <= view.scrollTop + frameLimits.spyOffset) reached = index
  const atEnd = view.scrollTop + view.clientHeight >= view.scrollHeight - 1
  if (!atEnd || reached === tops.length - 1) return reached
  const visible = (index: number) => tops[index] < view.scrollTop + view.clientHeight
  return chosen !== undefined && chosen >= reached && chosen < tops.length && visible(chosen) ? chosen : tops.length - 1
}

export interface ScriptPreview {
  /** What the drawer draws: the whole script, or its first lines up to frameLimits. */
  readonly text: string
  readonly lines: number
  readonly shownLines: number
  readonly truncated: boolean
}

/** A script cut to what the drawer draws, at a line end; an empty script is no lines. */
export function scriptPreview(script: string, limits: { readonly previewCharacters: number; readonly previewLines: number } = frameLimits): ScriptPreview {
  const lines = script ? countLines(script) : 0
  let end = Math.min(script.length, limits.previewCharacters)
  let shown = 0
  for (let index = script.indexOf('\n'); index >= 0 && index < end; index = script.indexOf('\n', index + 1)) {
    if (++shown === limits.previewLines) { end = index; break }
  }
  if (end < script.length && end === limits.previewCharacters) {
    // Cut at the last line end inside the limit, unless the first line alone is longer than it.
    const lineEnd = script.lastIndexOf('\n', end - 1)
    if (lineEnd > 0) end = lineEnd
  }
  // Only the final line end left over is nothing hidden.
  const truncated = end < script.length && !/^\r?\n$/.test(script.slice(end))
  const text = truncated ? script.slice(0, end).replace(/\r$/, '') : script
  return { text, lines, shownLines: truncated ? countLines(text) : lines, truncated }
}

function countLines(text: string): number {
  let count = 1
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count++
  // A final line end closes the last line rather than starting an empty one.
  return text.endsWith('\n') ? count - 1 : count
}

const plural = (count: number, word: string) => `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`

/** The drawer's caption beside its title: "12 lines". */
export function scriptLinesLabel(preview: ScriptPreview): string { return plural(preview.lines, 'line') }

/** Said under a cut preview: how much shows, and where the rest is. */
export function scriptPreviewNote(preview: ScriptPreview): string | undefined {
  if (!preview.truncated) return undefined
  return `Showing the first ${plural(preview.shownLines, 'line')} of ${formatCount(preview.lines)}. Open in Query Window or Copy takes the whole script.`
}

/** A section's name in the list: its title, and that it needs attention when it does (the glyph alone is decoration). */
export function sectionLabel(section: SectionInfo): string { return section.problem ? `${section.title} (needs attention)` : section.title }

/** A header verb's tooltip: its words, and its key on this platform when it has one ("Save (Ctrl+S)"). */
export function verbTooltip(label: string, key: { readonly text: string } | undefined): string { return key ? `${label} (${key.text})` : label }
