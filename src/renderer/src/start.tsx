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
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js'
// Completion providers need the suggestion controller in this deliberately small Monaco bundle.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
// The codicon font face: Monaco generates the glyph rules but loads the font only with this stylesheet.
import 'monaco-editor/features/codicon/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import App from './App'
import { createWorkbench } from './core/workbench'
import { registerJson } from './languages/json'
import { WorkbenchProvider } from './core/WorkbenchContext'
import { ShortcutsService } from './core/ShortcutsService'
import { toPlatform } from '../../shared/commands/keybindings'
import { domThemeTarget, ThemeService } from './services/theme'
import { SettingsService } from './settings/SettingsService'
import { ShellErrorBoundary, ShellFaultProbe } from './ShellFailure'
import Tile from './kit/Tile'
import { LiveChart } from './live/LiveChart'
import { liveTestHooks } from './live/test-hooks'
import { mountTestGrid } from './live/test-grid'
import { serverFilesTestHook } from './server-files/test-hook'
import { restoreTestHook } from './restore/test-hook'
import 'dockview-react/dist/styles/dockview.css'
import './styles.css'

/** Starts the workbench in `root`; main.tsx shows the failure screen when this module or its start fails. */
export async function start(root: Root): Promise<void> {
  // Bundle Monaco locally; the editor never downloads scripts from a CDN.
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  registerJson(monaco)
  // React renders only after a theme is applied, so the first frame already has its colors, with settings, so the
  // editor's first frame has its font and options, and with the user's shortcuts, so the first key and label follow
  // them; none waits for main longer than its timeout.
  const [theme, settings, shortcuts] = await Promise.all([
    ThemeService.create(window.varia, domThemeTarget(monaco)), SettingsService.create(window.varia),
    ShortcutsService.create({ api: window.varia.shortcuts, platform: toPlatform(window.varia.platform) })
  ])
  const workbench = createWorkbench(window.varia, monaco, theme, settings, shortcuts)
  // Smoke tests drive the results API directly (backend-smoke.mjs), read the grids' counters (results-smoke.mjs), save
  // AutoRecover's copies on demand (files-smoke.mjs) and open live views and their grids (live-smoke.mjs, live-grid-smoke.mjs); main enables test mode only in
  // unpackaged smoke runs.
  if (window.varia.testMode) {
    const stats = workbench.gridStats
    Object.assign(window, {
      __variaResults: workbench.resultClient,
      __variaGrid: {
        stats: async () => ({ ...stats?.snapshot(), client: await workbench.resultClient.stats() }),
        reset: () => stats?.reset(),
        setScrollCap: (px?: number) => stats?.setScrollCap(px),
        // Draws results grids transposed or as tables again (every grid, or one tab's or entry's), with an optional header
        // column, as the transpose commands do (ResultsService.setOrientation): the grid benchmark turns its grid with it.
        setOrientation: (transposed: boolean, o: { headerColumn?: number; tabId?: string; entry?: string } = {}) => {
          for (const [tabId, tab] of Object.entries(workbench.results.getSnapshot())) {
            if (o.tabId !== undefined && o.tabId !== tabId) continue
            for (const entry of tab.sets) if (o.entry === undefined || o.entry === entry.key) workbench.results.setOrientation(tabId, entry.key, { transposed, headerColumn: o.headerColumn ?? null })
          }
        }
      },
      // AutoRecover's save now, rather than in five minutes (files-smoke.mjs).
      __variaRecovery: { flush: () => workbench.recovery.flush() },
      // The server file picker before any dialog opens it (A17: no menu item until its OK works; object-actions-smoke.mjs).
      __variaServerFiles: serverFilesTestHook(workbench.serverFiles, workbench.connections),
      // Restore Database on the first live connection, without Object Explorer (object-actions-smoke.mjs).
      __variaRestore: restoreTestHook(workbench.restore, workbench.connections),
      // Live views on the synthetic source, charts and grids of them, the SSIS tree's views, and the window's visibility
      // (live-smoke.mjs, chart-smoke.mjs, live-grid-smoke.mjs, electron-smoke.mjs).
      __variaLive: liveTestHooks(workbench.live, workbench.documents, workbench.panes, (handle, probe, table, state) => mountTestGrid(workbench, handle, probe, table, state), container => {
        const chart = createRoot(container)
        return {
          render: (props, tile) => chart.render(<WorkbenchProvider workbench={workbench}>{tile ? <Tile caption={tile}><LiveChart {...props} /></Tile> : <LiveChart {...props} />}</WorkbenchProvider>),
          unmount: () => chart.unmount()
        }
      }, workbench.ssisTree)
    })
  }
  root.render(<React.StrictMode><ShellErrorBoundary><WorkbenchProvider workbench={workbench}><ShellFaultProbe /><App /></WorkbenchProvider></ShellErrorBoundary></React.StrictMode>)
  // Workbench lifetime is outside React effects, including StrictMode's effect replay.
  // Reloading discards unsaved queries and ends every SQL session; main asks before allowing it.
  // A confirmed exit has already handled each document, so it is never blocked here.
  window.addEventListener('beforeunload', event => {
    if (workbench.files.exiting) return
    const refreshed = window.varia.hotExit ? window.varia.refreshReloadPins(workbench.reloadPins) : undefined
    if (refreshed && !refreshed.ok) workbench.commands.reportError(refreshed.error)
    else if (!workbench.documents.getSnapshot().documents.some(document => document.dirty) && !workbench.connections.live().length) return
    event.preventDefault()
    event.returnValue = true
  })
  const unload = () => workbench.dispose()
  window.addEventListener('unload', unload, { once: true })
  if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener('unload', unload); root.unmount(); workbench.dispose() })
}
