import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/languages/definitions/sql/register.js'
// XML, JSON and plan values open from the results grid in their own tabs.
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
// Insert Snippet and Surround With insert through it; it adds only Tab, Shift+Tab and Escape while a snippet is active.
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
// The codicon font face: Monaco generates the glyph rules but loads the font only with this stylesheet.
import 'monaco-editor/features/codicon/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import App from './App'
import { createWorkbench } from './core/workbench'
import { registerJson } from './languages/json'
import { WorkbenchProvider } from './core/WorkbenchContext'
import { domThemeTarget, ThemeService } from './services/theme'
import { SettingsService } from './settings/SettingsService'
import { ShellErrorBoundary, ShellFaultProbe } from './ShellFailure'
import Tile from './kit/Tile'
import { LiveChart } from './live/LiveChart'
import { liveTestHooks } from './live/test-hooks'
import 'dockview-react/dist/styles/dockview.css'
import './styles.css'

/** Starts the workbench in `root`; main.tsx shows the failure screen when this module or its start fails. */
export async function start(root: Root): Promise<void> {
  // Bundle Monaco locally; the editor never downloads scripts from a CDN.
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  registerJson(monaco)
  // React renders only after a theme is applied, so the first frame already has its colors, and with settings, so the
  // editor's first frame has its font and options; neither waits for main longer than its timeout.
  const [theme, settings] = await Promise.all([ThemeService.create(window.varia, domThemeTarget(monaco)), SettingsService.create(window.varia)])
  const workbench = createWorkbench(window.varia, monaco, theme, settings)
  // Smoke tests drive the results API directly (backend-smoke.mjs), read the grids' counters (results-smoke.mjs), save
  // AutoRecover's copies on demand (files-smoke.mjs) and open live views (live-smoke.mjs); main enables test mode only in
  // unpackaged smoke runs.
  if (window.varia.testMode) {
    const stats = workbench.gridStats
    Object.assign(window, {
      __variaResults: workbench.resultClient,
      __variaGrid: {
        stats: async () => ({ ...stats?.snapshot(), client: await workbench.resultClient.stats() }),
        reset: () => stats?.reset(),
        setScrollCap: (px?: number) => stats?.setScrollCap(px)
      },
      // AutoRecover's save now, rather than in five minutes (files-smoke.mjs).
      __variaRecovery: { flush: () => workbench.recovery.flush() },
      // Live views on the synthetic source, charts of them, and the window's visibility (live-smoke.mjs, chart-smoke.mjs).
      __variaLive: liveTestHooks(workbench.live, workbench.documents, workbench.panes, container => {
        const chart = createRoot(container)
        return {
          render: (props, tile) => chart.render(<WorkbenchProvider workbench={workbench}>{tile ? <Tile caption={tile}><LiveChart {...props} /></Tile> : <LiveChart {...props} />}</WorkbenchProvider>),
          unmount: () => chart.unmount()
        }
      })
    })
  }
  root.render(<React.StrictMode><ShellErrorBoundary><WorkbenchProvider workbench={workbench}><ShellFaultProbe /><App /></WorkbenchProvider></ShellErrorBoundary></React.StrictMode>)
  // Workbench lifetime is outside React effects, including StrictMode's effect replay.
  // Reloading discards unsaved queries and ends every SQL session; main asks before allowing it.
  // A confirmed exit has already handled each document, so it is never blocked here.
  window.addEventListener('beforeunload', event => {
    if (workbench.files.exiting) return
    if (!workbench.documents.getSnapshot().documents.some(document => document.dirty) && !workbench.connections.live().length) return
    event.preventDefault()
    event.returnValue = true
  })
  const unload = () => workbench.dispose()
  window.addEventListener('unload', unload, { once: true })
  if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener('unload', unload); root.unmount(); workbench.dispose() })
}
