import { defineConfig } from 'vitest/config'
import { classifyVitestIsolation, classifyVitestOsScope } from './scripts/vitest-scope.mjs'

const osOnly = process.env.VARIA_VITEST_SCOPE === 'os'
const allowed = osOnly ? new Set(classifyVitestOsScope().osSensitive) : null
const { stateless, isolated } = classifyVitestIsolation()
const filter = (files: string[]) => allowed ? files.filter(file => allowed.has(file)) : files

const sharedTest = {
  testTimeout: 20000,
  hookTimeout: 20000,
  // Monaco's ESM imports its CSS; inlining lets Vite turn those imports into empty modules for tests that load the editor.
  server: { deps: { inline: [/monaco-editor/] } }
}

export default defineConfig({
  test: {
    // The slow-test list says when each long test ran, to lay a starved one against check.mjs's other lanes.
    reporters: ['default', './tests/fixtures/slow-test-reporter.ts'],
    projects: [
      {
        test: {
          ...sharedTest,
          name: 'stateless',
          include: filter(stateless),
          isolate: false
        }
      },
      {
        test: {
          ...sharedTest,
          name: 'isolated',
          include: filter(isolated),
          isolate: true
        }
      }
    ]
  }
})
