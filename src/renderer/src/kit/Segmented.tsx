import { useRef, type AriaAttributes, type KeyboardEvent } from 'react'

export interface Segment { readonly value: string; readonly label: string }
/** Enums with this many values or fewer show as a segmented control; longer ones keep a list (Calm Pro's rule). */
export const segmentedMaximum = 4

/**
 * A segmented control's keys, as a radio group's: Right and Down move to the next value, Left and Up to the previous,
 * both wrapping, and Home and End go to the first and last. The index the key moves to; undefined for any other key.
 */
export function segmentKey(key: string, count: number, index: number): number | undefined {
  if (count <= 0) return undefined
  const from = index < 0 ? 0 : index
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return index < 0 ? 0 : (from + 1) % count
    case 'ArrowLeft': case 'ArrowUp': return index < 0 ? count - 1 : (from - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return undefined
  }
}

interface Props extends Pick<AriaAttributes, 'aria-describedby' | 'aria-invalid' | 'aria-errormessage'> {
  readonly id: string
  /** The element that names the group (the field's label). */
  readonly labelledBy: string
  readonly segments: readonly Segment[]
  readonly value: string
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  /** Marks a value that differs from what was read (`data-changed`). */
  readonly changed?: boolean
}

/**
 * A short enum as one row of segments (a radio group): one tab stop, on the chosen value, and the arrow keys choose as
 * they move, as radio buttons do. The chosen segment is filled, outlined and bold, so the choice is not colour alone. A
 * value no segment has (one SQL Server reports that the list does not offer) leaves none chosen.
 */
export default function Segmented({ id, labelledBy, segments, value, onChange, disabled, changed, ...aria }: Props) {
  const group = useRef<HTMLDivElement>(null)
  const chosen = segments.findIndex(segment => segment.value === value)
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const next = segmentKey(event.key, segments.length, chosen)
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    if (segments[next].value !== value) onChange(segments[next].value)
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return <div ref={group} id={id} className="segmented" role="radiogroup" aria-labelledby={labelledBy} aria-disabled={disabled || undefined} data-changed={changed || undefined} {...aria} onKeyDown={keyDown}>
    {segments.map((segment, index) => <button key={segment.value} type="button" role="radio" className="segmented-option" aria-checked={index === chosen} disabled={disabled}
      tabIndex={index === (chosen < 0 ? 0 : chosen) ? 0 : -1} onClick={() => { if (segment.value !== value) onChange(segment.value) }}>{segment.label}</button>)}
  </div>
}
