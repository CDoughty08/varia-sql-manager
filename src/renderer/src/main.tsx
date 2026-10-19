import { createRoot } from 'react-dom/client'
import { showStartupFailure } from './ShellFailure'

// The workbench is its own chunk, so a module that throws while it loads, or a chunk that cannot load, still shows the
// failure screen with Reload instead of a blank window. The build keeps all CSS in one stylesheet that the page links,
// so the failure screen is styled even then (electron.vite.config.ts).
const root = createRoot(document.getElementById('root')!)
import('./start').then(({ start }) => start(root)).catch(error => { showStartupFailure(error, root) })
