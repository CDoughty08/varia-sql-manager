import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    plugins: [react()],
    server: { host: '127.0.0.1' },
    // electron-vite leaves the renderer unminified by default (about 8 MB of JavaScript to parse at startup).
    build: { minify: true },
    worker: { format: 'es' }
  }
})
