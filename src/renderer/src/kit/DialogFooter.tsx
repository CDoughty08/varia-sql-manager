import { useEffect, useRef, type ReactNode } from 'react'

export interface DialogFooterConfirm {
  readonly message: string
  readonly keepLabel?: string
  readonly discardLabel?: string
  readonly disabled?: boolean
  onKeep(): void
  onDiscard(): void
}

export interface DialogFooterProps {
  /** Secondary actions anchored at the start of the footer row. */
  readonly leading?: ReactNode
  /** Flexible status, staged count, or blocker text rendered between leading and trailing actions. */
  readonly status?: ReactNode
  /** Primary and dismissal actions anchored at the end of the footer row. */
  readonly trailing?: ReactNode
  /** Custom footer groups (for compound layouts such as Connect's two action groups). */
  readonly children?: ReactNode
  /** Wrap buttons onto additional lines cleanly inside narrow dialogs. */
  readonly wrap?: boolean
  /** In-place confirmation state that temporarily replaces the footer actions without changing dialog height. */
  readonly confirm?: DialogFooterConfirm
  readonly className?: string
}

/**
 * Shared dialog action bar with uniform 8 px edge spacing and optional in-place confirmation swap.
 * Retains `.connection-footer` alongside `.dialog-footer` so smoke probes and layout styles apply uniformly.
 */
export default function DialogFooter({ leading, status, trailing, children, wrap, confirm, className }: DialogFooterProps) {
  const keepRef = useRef<HTMLButtonElement>(null)
  const confirming = !!confirm
  useEffect(() => {
    if (confirming) keepRef.current?.focus()
  }, [confirming])

  const classes = [
    'connection-footer',
    'dialog-footer',
    wrap && !confirm ? 'is-wrap' : '',
    confirm ? 'is-confirming' : '',
    className ?? ''
  ].filter(Boolean).join(' ')

  if (confirm) {
    return <div className={classes} role="alert">
      <span className="dialog-footer-message">{confirm.message}</span>
      <button ref={keepRef} type="button" className="ui-button" data-control-variant="secondary" autoFocus disabled={confirm.disabled} onClick={confirm.onKeep}>
        {confirm.keepLabel ?? 'Keep Editing'}
      </button>
      <button type="button" className="ui-button primary" disabled={confirm.disabled} onClick={confirm.onDiscard}>
        {confirm.discardLabel ?? 'Discard Changes'}
      </button>
    </div>
  }

  if (children !== undefined) return <div className={classes}>{children}</div>

  const spacer = status !== undefined ? status : (!wrap || leading ? <span className="dialog-footer-spacer" /> : null)
  return <div className={classes}>
    {leading}
    {spacer}
    {trailing}
  </div>
}
