import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { contentSecurityPolicy } from './src/shared/csp'

/** Production pages carry main's policy themselves, first in <head>, before any script; the dev server's page cannot. */
export const cspMeta: Plugin = {
  name: 'varia-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy() }, injectTo: 'head-prepend' }]
}

const vendoredDomPurify = /\/monaco-editor\/esm\/vs\/base\/browser\/dompurify\/dompurify\.js$/
// DOMPurify's own statement of its version, as written, bundled or minified.
const domPurifyVersion = /\.version\s*=\s*["'](\d+\.\d+\.\d+)["'][,;]\s*[\w$]+\.removed\s*=\s*\[\]/g

/** The versions of every DOMPurify copy in `code`. */
export const domPurifyVersions = (code: string) => [...code.matchAll(domPurifyVersion)].map(match => match[1])

/**
 * Monaco sanitises markdown (hovers, suggestion details) with a DOMPurify it vendors, 3.4.15 in Monaco 0.57, which no
 * package.json override reaches. This resolves that file to the installed dompurify package (the same 3.x API; package.json
 * and tests/dependency-floors.test.ts hold its version), and refuses a bundle that ships any other copy.
 */
export function patchedDomPurify(): Plugin {
  const installed = () => (JSON.parse(readFileSync('node_modules/dompurify/package.json', 'utf8')) as { version: string }).version
  return {
    name: 'varia-patched-dompurify',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.endsWith('dompurify.js')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved || !vendoredDomPurify.test(resolved.id.replaceAll('\\', '/'))) return null
      // From the project, not from Monaco's folder: the copy package.json pins.
      const patched = await this.resolve('dompurify', undefined, { ...options, skipSelf: true })
      if (!patched) throw new Error('The dompurify package that replaces the copy Monaco vendors is not installed.')
      return patched
    },
    generateBundle(_, bundle) {
      const expected = installed()
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue
        const other = domPurifyVersions(chunk.code).filter(version => version !== expected)
        if (other.length) this.error(`${file} ships DOMPurify ${other.join(', ')}, not the installed ${expected}.`)
      }
    }
  }
}

export default defineConfig({
  main: {},
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    plugins: [react(), cspMeta, patchedDomPurify()],
    server: { host: '127.0.0.1' },
    // electron-vite leaves the renderer unminified by default (about 8 MB of JavaScript to parse at startup).
    // One stylesheet, linked by the page, in the order the modules import it (Monaco's, then Dockview's, then
    // styles.css, which overrides both): the failure screen keeps its styles when the workbench chunk cannot load.
    build: { minify: true, cssCodeSplit: false },
    worker: { format: 'es' }
  }
})
