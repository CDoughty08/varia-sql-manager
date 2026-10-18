import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { contentSecurityPolicy } from './src/shared/csp'

/** Production pages carry main's policy themselves, first in <head>, before any script; the dev server's page cannot. */
export const cspMeta: Plugin = {
  name: 'varia-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy() }, injectTo: 'head-prepend' }]
}

export default defineConfig({
  main: {},
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    plugins: [react(), cspMeta],
    server: { host: '127.0.0.1' },
    // electron-vite leaves the renderer unminified by default (about 8 MB of JavaScript to parse at startup).
    // One stylesheet, linked by the page, in the order the modules import it (Monaco's, then Dockview's, then
    // styles.css, which overrides both): the failure screen keeps its styles when the workbench chunk cannot load.
    build: { minify: true, cssCodeSplit: false },
    worker: { format: 'es' }
  }
})
