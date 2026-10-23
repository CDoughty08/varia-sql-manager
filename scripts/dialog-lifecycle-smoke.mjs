// Focused renderer crash, native dialog ordering, reload and quit coverage; also run by menus-smoke.mjs.
import { mkdir } from 'node:fs/promises'
import { dialogLifecycle, rendererWatchdog } from './fixtures/dialog-lifecycle.mjs'
import { sessionPrompts } from './fixtures/session-prompts.mjs'

await mkdir('artifacts', { recursive: true })
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath }
delete env.ELECTRON_RUN_AS_NODE
const watchdog = setTimeout(() => { console.error('Dialog lifecycle suite exceeded five minutes.'); process.exit(1) }, 300000)
try {
  const options = { args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }
  const dialogsStarted = performance.now()
  await dialogLifecycle(options)
  console.log(`Dialog lifecycle checks passed in ${Math.round(performance.now() - dialogsStarted)} ms.`)
  const watchdogStarted = performance.now()
  await rendererWatchdog(options)
  console.log(`Renderer watchdog checks passed in ${Math.round(performance.now() - watchdogStarted)} ms.`)
  const sessionsStarted = performance.now()
  await sessionPrompts(options)
  console.log(`Session prompt checks passed in ${Math.round(performance.now() - sessionsStarted)} ms.`)
} finally { clearTimeout(watchdog) }
