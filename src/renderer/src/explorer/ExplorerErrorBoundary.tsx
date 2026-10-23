import { Component, createRef, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { onUnexpectedError } from '../core/errors'
import type { ErrorReport } from '../kit/format'
import InlineError from '../kit/InlineError'
import { failureDetails } from '../ShellFailure'

/** What the fault says, and what Copy details takes: the sentence, then the fault and its component stack. */
export const explorerFault = (details?: string): ErrorReport => ({ message: 'Object Explorer stopped because of a rendering error.', extra: details })

/** Focus went with an element that was removed. */
export const focusLost = (): boolean => !document.activeElement || document.activeElement === document.body

/**
 * Keeps a rendering fault in the tree inside Object Explorer: the pane says so and offers to reload the tree, which
 * rebuilds it from the connections. Connections and query tabs are untouched. Focus that went with the tree moves to
 * the Reload button, and after Reload to the new tree (`onReloaded`). Copy details takes the fault and where it
 * happened, for a report.
 */
export default class ExplorerErrorBoundary extends Component<{ readonly onReload: () => void; readonly onReloaded?: () => void; readonly children: ReactNode }, { readonly failed: boolean; readonly details?: string }> {
  state: { readonly failed: boolean; readonly details?: string } = { failed: false }
  private readonly reload = createRef<HTMLButtonElement>()
  private reloading = false
  static getDerivedStateFromError(error: unknown): { failed: boolean; details: string } { return { failed: true, details: failureDetails(error) } }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ details: failureDetails(error, info.componentStack) })
    onUnexpectedError(Object.assign(error instanceof Error ? error : new Error(String(error)), { componentStack: info.componentStack }))
  }
  componentDidUpdate(_props: unknown, previous: { readonly failed: boolean }): void {
    if (this.state.failed && !previous.failed && focusLost()) this.reload.current?.focus()
    if (!this.state.failed && previous.failed && this.reloading) { this.reloading = false; this.props.onReloaded?.() }
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <InlineError className="explorer-fault" {...explorerFault(this.state.details)}
      actions={[{ label: 'Reload Object Explorer', buttonRef: this.reload, run: () => { this.props.onReload(); this.reloading = true; this.setState({ failed: false, details: undefined }) } }]} />
  }
}

/**
 * Smoke builds only (main's test mode): `window.__variaTestExplorerFault()` makes the tree's next render throw, so the
 * suite can check the boundary and its Reload. The fault is this component's state, which the boundary discards.
 */
export function FaultProbe(): null {
  const [fault, setFault] = useState(false)
  useEffect(() => {
    if (!window.varia?.testMode) return
    const trigger = () => setFault(true)
    const host = window as unknown as { __variaTestExplorerFault?: () => void }
    host.__variaTestExplorerFault = trigger
    return () => { if (host.__variaTestExplorerFault === trigger) delete host.__variaTestExplorerFault }
  }, [])
  if (fault) throw new Error('Object Explorer test fault.')
  return null
}
