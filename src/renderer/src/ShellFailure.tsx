import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { colorKeys, cssVariable } from '../../shared/theme/registry'
import { resolveBuiltin } from '../../shared/theme/resolve'
import { onUnexpectedError } from './core/errors'

const maxDetails = 16_000

/** What Copy details puts on the clipboard: the error and where it happened, bounded. */
export function failureDetails(error: unknown, componentStack?: string | null): string {
  const base = error instanceof Error ? (error.stack?.includes(error.message) ? error.stack : `${error.name}: ${error.message}\n${error.stack ?? ''}`) : String(error)
  const text = [`Varia SQL Manager ${window.varia?.platform ?? ''}`.trim(), base.trim(), componentStack ? 'Component stack:' + componentStack.replace(/\s+$/, '') : '']
    .filter(Boolean).join('\n\n')
  return text.length > maxDetails ? text.slice(0, maxDetails - 1) + '…' : text
}

/**
 * Logs a fault the shell caught. Smoke runs (main's test mode) must still fail on it, so there it is also thrown again
 * outside React, where the suites' `pageerror` listeners see it, and kept in `window.__variaFailures`.
 */
export function reportShellFailure(error: unknown): void {
  onUnexpectedError(error)
  if (!window.varia?.testMode) return
  const host = window as unknown as { __variaFailures?: string[] }
  ;(host.__variaFailures ??= []).push(error instanceof Error ? error.message : String(error))
  setTimeout(() => { throw error })
}

/** The page has no theme when startup failed before one was applied; the failure screen then shows the built-in one. */
function ensureTheme(root: HTMLElement = document.documentElement): void {
  if (root.style.getPropertyValue(cssVariable('editor.background'))) return
  const theme = resolveBuiltin(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  for (const key of colorKeys) root.style.setProperty(cssVariable(key), theme.colors[key])
  root.style.colorScheme = theme.type
}

type CopyState = '' | 'copied' | 'failed'
/** Through main, the page's only clipboard path; without main's API the details are selected for the user to copy. */
async function copy(details: string): Promise<boolean> {
  try { return !!window.varia && (await window.varia.writeClipboardText(details)).ok } catch { return false }
}
/** Main reloads the window as View › Reload Window does (it refuses navigation the page starts itself). */
function reload(): void {
  const fallback = () => location.reload()
  if (!window.varia) { fallback(); return }
  window.varia.runRole('reload').then(result => { if (!result.ok) fallback() }, fallback)
}
const selectDetails = () => {
  const details = document.querySelector('.shell-failure-details')
  if (details) { getSelection()?.selectAllChildren(details); (details as HTMLElement).focus() }
}

/** The whole window when the workbench cannot run: what happened, Reload, and the details to report it. */
export function FailureScreen({ title, details }: { readonly title: string; readonly details: string }) {
  const [copied, setCopied] = useState<CopyState>('')
  // Focus went with the workbench; Reload is what most people want next.
  useEffect(() => { document.querySelector<HTMLButtonElement>('.shell-failure button.primary')?.focus() }, [])
  return <main className="shell-failure" aria-labelledby="shell-failure-title">
    <div role="alert">
      <h1 id="shell-failure-title">{title}</h1>
      <p>Reload starts the workbench again; unsaved queries are lost. Copy details to report what went wrong.</p>
    </div>
    <div className="shell-failure-actions">
      <button className="primary" onClick={reload}>Reload</button>
      <button onClick={() => { void copy(details).then(ok => { setCopied(ok ? 'copied' : 'failed'); if (!ok) selectDetails() }) }}>Copy details</button>
      <span role="status">{copied === 'copied' ? 'Details copied.' : copied === 'failed' ? 'The details could not be copied. They are selected below for you to copy.' : ''}</span>
    </div>
    <pre className="shell-failure-details" aria-label="Details" tabIndex={0}>{details}</pre>
  </main>
}

/**
 * Catches a rendering fault anywhere in the workbench and shows the failure screen instead of a blank window. The
 * workbench's services outlive React, so main's prompts still guard unsaved queries when the page reloads.
 */
export class ShellErrorBoundary extends Component<{ readonly children: ReactNode }, { readonly failure?: string }> {
  state: { readonly failure?: string } = {}
  static getDerivedStateFromError(error: unknown): { failure: string } { return { failure: failureDetails(error) } }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ failure: failureDetails(error, info.componentStack) })
    reportShellFailure(error)
  }
  render(): ReactNode {
    return this.state.failure === undefined ? this.props.children : <FailureScreen title="The workbench stopped because of an error." details={this.state.failure} />
  }
}

/** Startup failed (no theme, no workbench, or no main process API): the failure screen replaces whatever rendered. */
export function showStartupFailure(error: unknown, root: Root): void {
  reportShellFailure(error)
  ensureTheme()
  root.render(<FailureScreen title="Varia SQL Manager could not start." details={failureDetails(error)} />)
}

/**
 * Smoke builds only (main's test mode): `window.__variaTestShellFault()` makes the workbench's next render throw, so
 * the suite can check the failure screen and that the fault still reaches it as a page error.
 */
export function ShellFaultProbe(): null {
  const [fault, setFault] = useState(false)
  useEffect(() => {
    if (!window.varia?.testMode) return
    const trigger = () => setFault(true)
    const host = window as unknown as { __variaTestShellFault?: () => void }
    host.__variaTestShellFault = trigger
    return () => { if (host.__variaTestShellFault === trigger) delete host.__variaTestShellFault }
  }, [])
  if (fault) throw new Error('Workbench test fault.')
  return null
}
