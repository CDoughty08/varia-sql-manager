import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Monaco's ESM imports its CSS; inlining lets Vite turn those imports into empty modules for tests that load the editor.
  // The slow-test list says when each long test ran, to lay a starved one against check.mjs's other lanes.
  test: { include: ['tests/**/*.test.ts'], reporters: ['default', './tests/fixtures/slow-test-reporter.ts'], setupFiles: process.env.CI ? ['./tests/fixtures/diag-worker.ts'] : [], testTimeout: 20000, hookTimeout: 20000, server: { deps: { inline: [/monaco-editor/] } } }
})
