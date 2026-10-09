import { Component, type ErrorInfo, type ReactNode } from 'react'
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
