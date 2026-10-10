import { Component, createRef, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { onUnexpectedError } from '../core/errors'

/** Focus went with an element that was removed. */
export const focusLost = (): boolean => !document.activeElement || document.activeElement === document.body

/**
 * Keeps a rendering fault in the tree inside Object Explorer: the pane says so and offers to reload the tree, which
 * rebuilds it from the connections. Connections and query tabs are untouched. Focus that went with the tree moves to
 * the Reload button, and after Reload to the new tree (`onReloaded`).
 */
export default class ExplorerErrorBoundary extends Component<{ readonly onReload: () => void; readonly onReloaded?: () => void; readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false }
  private readonly reload = createRef<HTMLButtonElement>()
  private reloading = false
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: unknown, info: ErrorInfo): void { onUnexpectedError(Object.assign(error instanceof Error ? error : new Error(String(error)), { componentStack: info.componentStack })) }
  componentDidUpdate(_props: unknown, previous: { readonly failed: boolean }): void {
    if (this.state.failed && !previous.failed && focusLost()) this.reload.current?.focus()
    if (!this.state.failed && previous.failed && this.reloading) { this.reloading = false; this.props.onReloaded?.() }
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div className="explorer-fault" role="alert">
      <p>Object Explorer stopped because of a rendering error.</p>
      <button ref={this.reload} onClick={() => { this.props.onReload(); this.reloading = true; this.setState({ failed: false }) }}>Reload Object Explorer</button>
    </div>
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
