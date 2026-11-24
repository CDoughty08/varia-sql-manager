import { useEffect, useRef, useState, type ReactNode } from 'react'
import Icon from '../Icon'

export interface FactItem {
  readonly id?: string
  readonly label: string
  readonly value?: string | null
  /** Optional rich content (for example a StatusPill); `copyValue` or `value` still supplies the copied text. */
  readonly content?: ReactNode
  /** Draw the value in the monospace stack (types, collations, paths, identifiers). */
  readonly mono?: boolean
  readonly title?: string
  /** Explicit text copied by the copy button; defaults to `value`. */
  readonly copyValue?: string
  /** Set false to suppress the hover/focus copy button on this row. */
  readonly copyable?: boolean
  /** Optional cross-object navigation link rendered as a button on the value. */
  readonly onLink?: () => void
  readonly linkLabel?: string
}

export interface FactGridProps {
  readonly facts: readonly FactItem[]
  /** Compact column proportions for the Vitals rail. */
  readonly compact?: boolean
  readonly className?: string
  /** Override clipboard writer for tests; defaults to `window.varia.writeClipboardText`. */
  readonly onCopy?: (text: string) => void | Promise<unknown>
}

const copiedResetMs = 1500

/**
 * Unified read-only key/value grid (`minmax(156px, 28%) 1fr`), aligned on the same 16 px left rail and label column
 * as editable `PropertyField` rows. Each non-empty row exposes a hover/focus-visible copy button writing through
 * `window.varia.writeClipboardText` and announcing "Copied" in a polite status region.
 */
export default function FactGrid({ facts, compact = false, className, onCopy }: FactGridProps) {
  const [copiedId, setCopiedId] = useState<string | undefined>(undefined)
  const [announcement, setAnnouncement] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)

  useEffect(() => () => {
    // Invalidate any pending clipboard promise so unmount never schedules a stray timer or state update.
    seq.current++
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

  const copy = (rowKey: string, label: string, text: string) => {
    const writer = onCopy ?? (typeof window !== 'undefined' && window.varia?.writeClipboardText ? (value: string) => window.varia.writeClipboardText(value) : undefined)
    if (!writer) return
    const token = ++seq.current
    const announce = () => {
      if (seq.current !== token) return
      setCopiedId(rowKey)
      // Trailing zero-width space alternates on consecutive copies so assistive tech announces repeats cleanly.
      setAnnouncement(token % 2 === 0 ? `Copied ${label}` : `Copied ${label}\u200B`)
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = undefined
        if (seq.current === token) setCopiedId(undefined)
      }, copiedResetMs)
    }
    try {
      const result = writer(text)
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as PromiseLike<{ ok?: boolean } | void>).then(outcome => {
          if (outcome && typeof outcome === 'object' && 'ok' in outcome && outcome.ok === false) return
          announce()
        }, () => {})
      } else {
        announce()
      }
    } catch {
      // Clipboard write failures stay silent and leave the UI responsive.
    }
  }

  return <>
    <dl className={['fact-grid', compact && 'compact', className].filter(Boolean).join(' ')}>
      {facts.map((fact, index) => {
        const rowKey = fact.id ?? `${fact.label}-${index}`
        const raw = fact.value ?? ''
        const empty = !fact.content && raw === ''
        const copyText = fact.copyValue ?? raw
        const canCopy = fact.copyable !== false && copyText !== ''
        const isCopied = copiedId === rowKey
        const display = fact.content ?? (empty ? '—' : raw)
        const valueClass = ['fact-grid-val', fact.mono && 'mono', empty && 'muted'].filter(Boolean).join(' ')
        return <div key={rowKey} className="fact-grid-row">
          <dt>{fact.label}</dt>
          <dd title={fact.title ?? (empty ? undefined : raw || undefined)}>
            <span className={valueClass}>
              {fact.onLink && !empty
                ? <button type="button" className="fact-grid-link" aria-label={fact.linkLabel} onClick={fact.onLink}>{display}</button>
                : display}
            </span>
            {canCopy && <button type="button" className={isCopied ? 'fact-grid-copy copied' : 'fact-grid-copy'}
              aria-label={isCopied ? `Copied ${fact.label}` : `Copy ${fact.label}`} title={isCopied ? 'Copied' : `Copy ${fact.label}`}
              onClick={() => copy(rowKey, fact.label, copyText)}>
              <Icon name={isCopied ? 'check' : 'copy'} />
            </button>}
          </dd>
        </div>
      })}
    </dl>
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </>
}
