import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { onUnexpectedError } from '../core/errors'

/**
 * Keeps a rendering fault in the tree inside Object Explorer: the pane says so and offers to reload the tree, which
 * rebuilds it from the connections. Connections and query tabs are untouched.
 */
export default class ExplorerErrorBoundary extends Component<{ readonly onReload: () => void; readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: unknown, info: ErrorInfo): void { onUnexpectedError(Object.assign(error instanceof Error ? error : new Error(String(error)), { componentStack: info.componentStack })) }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div className="explorer-fault" role="alert">
      <p>Object Explorer stopped because of a rendering error.</p>
      <button onClick={() => { this.props.onReload(); this.setState({ failed: false }) }}>Reload Object Explorer</button>
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
