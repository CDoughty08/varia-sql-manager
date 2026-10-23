// Focused renderer crash, native dialog ordering, reload and quit coverage; also run by menus-smoke.mjs.
import { mkdir } from 'node:fs/promises'
import { dialogLifecycle } from './fixtures/dialog-lifecycle.mjs'

await mkdir('artifacts', { recursive: true })
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE
const watchdog = setTimeout(() => { console.error('Dialog lifecycle suite exceeded five minutes.'); process.exit(1) }, 300000)
try {
  await dialogLifecycle({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  console.log('Dialog lifecycle smoke checks passed.')
} finally { clearTimeout(watchdog) }
