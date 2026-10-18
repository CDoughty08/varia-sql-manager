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
    build: { minify: true },
    worker: { format: 'es' }
  }
})
