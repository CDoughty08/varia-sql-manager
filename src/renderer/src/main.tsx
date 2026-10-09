import React from 'react'
import { createRoot } from 'react-dom/client'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/languages/definitions/sql/register.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
// The codicon font face: Monaco generates the glyph rules but loads the font only with this stylesheet.
import 'monaco-editor/features/codicon/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import App from './App'
import { createWorkbench } from './core/workbench'
import { WorkbenchProvider } from './core/WorkbenchContext'
import { domThemeTarget, ThemeService } from './services/theme'
import 'dockview-react/dist/styles/dockview.css'
import './styles.css'

// Bundle Monaco locally; the editor never downloads scripts from a CDN.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
async function start() {
  // React renders only after a theme is applied, so the first frame already has its colors.
  const theme = await ThemeService.create(window.varia, domThemeTarget(monaco))
  const workbench = createWorkbench(window.varia, monaco, theme)
  // Smoke tests drive the results API directly (backend-smoke.mjs); main enables test mode only in unpackaged smoke runs.
  if (window.varia.testMode) Object.assign(window, { __variaResults: workbench.results })
  const root = createRoot(document.getElementById('root')!)
  root.render(<React.StrictMode><WorkbenchProvider workbench={workbench}><App /></WorkbenchProvider></React.StrictMode>)
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
void start()
