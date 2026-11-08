import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Monaco's ESM imports its CSS; inlining lets Vite turn those imports into empty modules for tests that load the editor.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, hookTimeout: 20000, server: { deps: { inline: [/monaco-editor/] } } }
})
