import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { chordFromEvent, formatLabel, keybindingLabel, parseKeySpec, type KeybindingLabel, type Platform } from '../../../../shared/commands/keybindings'

/**
 * Routes key presses to a capture box: `KeybindingService.capture` in the workbench, which takes every key before menus,
 * access keys and dispatch (Tab excepted) and joins Ctrl/⌘+K with the next chord. Returns the function that stops it.
 */
export type CaptureSource = (onChord: (chord: string) => void, options: { readonly onPrefix?: (chord: string) => void; readonly onPrefixCancel?: () => void }) => () => void

/** How long a Ctrl/⌘+K prefix waits for its second key, as Monaco's chord mode (`nativeChordTimeout`). */
const prefixTimeout = 5000

/** A chord list as key caps: one `<kbd>` per chord, read aloud as a whole. `source` styles a user or removed shortcut. */
export function KeyCaps({ label, source }: { readonly label: KeybindingLabel; readonly source?: string }) {
  return <span className="keybinding shortcuts-keys" role="img" aria-label={label.aria} data-source={source}>{label.parts.map((part, index) => <kbd key={index} aria-hidden="true">{part}</kbd>)}</span>
}

interface Props {
  readonly id: string
  readonly platform: Platform
  /** The chords recorded so far; empty for none. */
  readonly value: readonly string[]
  readonly onChange: (chords: readonly string[]) => void
  /** The workbench's capture; without one the field reads its own key presses (tests, and builds before it existed). */
  readonly capture?: CaptureSource
  readonly label: string
  readonly placeholder?: string
  readonly describedBy?: string
  readonly autoFocus?: boolean
  readonly className?: string
}

/**
 * SSMS's "Press shortcut keys" box: while it has focus every key press is recorded, Escape and Enter included, and
 * Tab and Shift+Tab leave it. Ctrl+K (⌘K) waits for a second key, for a two-part shortcut. Read-only text, so screen
 * readers announce what was recorded.
 */
export default function CaptureField({ id, platform, value, onChange, capture, label, placeholder = 'Press a shortcut', describedBy, autoFocus, className }: Props) {
  const [prefix, setPrefix] = useState<{ chord: string; at: number }>()
  const stop = useRef<() => void>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const prefixChord = parseKeySpec('mod+k', platform)[0]
  // The capture outlives the render that started it; it reports to the latest onChange.
  const latest = useRef(onChange), source = useRef(capture)
  latest.current = onChange
  source.current = capture
  const record = (chord: string) => { setPrefix(undefined); latest.current(chord.split(' ')) }
  const start = () => {
    if (!source.current) return
    stop.current?.()
    stop.current = source.current(record, { onPrefix: chord => setPrefix({ chord, at: Date.now() }), onPrefixCancel: () => setPrefix(undefined) })
  }
  const end = () => { stop.current?.(); stop.current = undefined; setPrefix(undefined) }
  useEffect(() => {
    // autoFocus starts the capture during the commit; StrictMode's replayed cleanup ends it, so a focused box restarts it.
    if (!stop.current && input.current && input.current === input.current.ownerDocument.activeElement) start()
    // The box is read-only; this also keeps IME and dead-key text out of it whatever the browser does with read-only fields.
    const element = input.current, cancel = (event: Event) => event.preventDefault()
    element?.addEventListener('beforeinput', cancel)
    return () => { element?.removeEventListener('beforeinput', cancel); end() }
  }, [])
  // A Ctrl/⌘+K prompt lapses as the chord does: after 5 s the next key is recorded on its own.
  useEffect(() => {
    if (!prefix) return
    const timer = setTimeout(() => setPrefix(current => current === prefix ? undefined : current), Math.max(0, prefix.at + prefixTimeout - Date.now()))
    return () => clearTimeout(timer)
  }, [prefix])
  // Without the workbench's capture the field reads its own keys, with the same rules.
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (capture || event.nativeEvent.isComposing || event.keyCode === 229) return
    const chord = chordFromEvent(event.nativeEvent, platform)
    if (chord === 'tab' || chord === 'shift+tab') { setPrefix(undefined); return }
    if (!chord) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat) return
    const now = Date.now()
    if (prefix && now - prefix.at <= prefixTimeout) { record(`${prefix.chord} ${chord}`); return }
    if (chord === prefixChord) { setPrefix({ chord, at: now }); return }
    record(chord)
  }
  const text = prefix ? `${formatLabel(prefix.chord, platform)}, …` : value.length ? keybindingLabel(value, platform).text : ''
  return <input ref={input} id={id} type="text" readOnly className={'shortcuts-capture' + (className ? ' ' + className : '')} aria-label={label} aria-describedby={describedBy} placeholder={placeholder}
    value={text} data-pending={prefix ? true : undefined} autoFocus={autoFocus} spellCheck={false} autoComplete="off" onFocus={start} onBlur={end} onKeyDown={keyDown} />
}
