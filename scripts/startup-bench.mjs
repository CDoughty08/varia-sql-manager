import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { trackElectronProcess, within } from './fixtures/smoke.mjs'
import { backendReady, documentTabSlots } from './fixtures/ui.mjs'

// Startup and memory benchmarks (npm run bench:startup): the built app with the Release backend, launched several times
// on one profile, then measured idle, with more query tabs, and holding a large result. Writes
// artifacts/bench/startup.json, which scripts/check-bench.mjs compares with tests/bench/floors.json. Needs the Release
// backend and out/ (npm run check). Every figure is report only: they describe what the shell costs, for docs/ipc.md.
const launches = 5, extraTabs = 20, resultRows = 500_000
const output = resolve('artifacts/bench/startup.json')
await mkdir(resolve('artifacts/bench'), { recursive: true })
await rm(output, { force: true })
const profile = await mkdtemp(resolve('artifacts', 'startup-bench-profile-'))
const metrics = {}
let app
let page
let step = 'launch'
const watchdog = setTimeout(() => { console.error(`Startup benchmarks timed out during: ${step}.`); app?.process()?.kill(); process.exit(1) }, 600000)

function record(id, value, unit, detail) {
  metrics[id] = { value, unit, ...detail ? { detail } : {} }
  console.log(`${id}: ${Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : Number(value.toPrecision(3))} ${unit}${detail ? ` (${detail})` : ''}`)
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
const spread = values => `${launches} launches after one discarded, ${Math.round(Math.min(...values))} – ${Math.round(Math.max(...values))} ms`
const mb = bytes => bytes / 1e6

/** Every process's parent, name and memory, as the system reports them: `rss` is the working set (resident set), and
 *  `private` the bytes no other process shares, where the platform tells them apart cheaply. */
function processTable() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.WorkingSetSize)|$($_.PrivatePageCount)|$($_.Name)" }'
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean).map(line => {
      const [pid, parent, rss, own, ...name] = line.split('|')
      return { pid: Number(pid), parent: Number(parent), rss: Number(rss), private: Number(own), name: name.join('|') }
    })
  }
  if (process.platform === 'linux') {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const status = readFileSync(`/proc/${name}/status`, 'utf8')
        const field = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0)
        return [{ pid: Number(name), parent: field('PPid'), rss: field('VmRSS') * 1024, private: (field('RssAnon') + field('VmSwap')) * 1024, name: /^Name:\s+(.*)$/m.exec(status)?.[1] ?? '' }]
      } catch { return [] }
    })
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), rss: Number(match[3]) * 1024, private: undefined, name: match[4] }] : []
  })
}

/** The app's whole process tree by role: Electron's own processes as it names them, the SQL backend, and anything else
 *  a process of ours started. Working sets count pages two processes share once each, so a sum overstates the tree by
 *  what Chromium's processes share; the private figure, where there is one, does not. */
async function memory() {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.detach()
  const roles = new Map(await app.evaluate(({ app }) => app.getAppMetrics().map(metric => [metric.pid, metric.type])))
  const backendPid = await app.evaluate(() => globalThis.__variaTest.pid())
  const table = processTable()
  const children = new Map()
  for (const row of table) children.set(row.parent, [...children.get(row.parent) ?? [], row])
  const root = app.process().pid
  const tree = table.filter(row => row.pid === root)
  for (let at = 0; at < tree.length; at++) tree.push(...(children.get(tree[at].pid) ?? []).filter(row => !tree.includes(row)))
  const sums = { total: 0, electron: 0, main: 0, renderer: 0, gpu: 0, utility: 0, backend: 0, other: 0, private: 0 }
  const others = []
  for (const row of tree) {
    const type = roles.get(row.pid)
    const role = row.pid === backendPid ? 'backend' : type === 'Browser' ? 'main' : type === 'Tab' ? 'renderer' : type === 'GPU' ? 'gpu' : type ? 'utility' : 'other'
    sums[role] += row.rss
    sums.total += row.rss
    if (role !== 'backend' && role !== 'other') sums.electron += row.rss
    if (row.private !== undefined) sums.private += row.private
    if (role === 'other') others.push(`${row.name} ${Math.round(mb(row.rss))}`)
  }
  return { ...sums, processes: tree.length, others, hasPrivate: tree.every(row => row.private !== undefined) }
}

/** Memory once it stops moving: sampled until two samples half a second apart agree within 1 %, ten times at most. */
async function settled() {
  let last = await memory()
  for (let tries = 0; tries < 10; tries++) {
    await new Promise(done => setTimeout(done, 500))
    const next = await memory()
    const steady = Math.abs(next.total - last.total) <= last.total * 0.01
    last = next
    if (steady) break
  }
  return last
}
const breakdown = sample => `main ${Math.round(mb(sample.main))}, renderer ${Math.round(mb(sample.renderer))}, GPU ${Math.round(mb(sample.gpu))}, utility ${Math.round(mb(sample.utility))}, backend ${Math.round(mb(sample.backend))}, other ${Math.round(mb(sample.other))} MB working set in ${sample.processes} processes${sample.hasPrivate ? `; ${Math.round(mb(sample.private))} MB private` : ''}${sample.others.length ? `; other: ${sample.others.join(', ')}` : ''}`

/**
 * Launches the app and times it from the main process's creation: the query editor in the page, and the status bar
 * naming the backend's runtime. The page's times come from an observer in the page, on the
 * page's own clock. A smoke-mode window starts hidden, so it is shown as it is created, as a user's is. Playwright
 * attaches a debugger to both processes, which a user's launch does not pay for.
 */
async function launch() {
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_BACKEND_TEST_HOOKS: '1', VARIA_RESULT_BUDGET_BYTES: String(1024 * 1024 * 1024) }
  delete env.ELECTRON_RUN_AS_NODE
  const before = Date.now()
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it.
  app = trackElectronProcess(await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 }))
  const created = await app.evaluate(({ app, BrowserWindow }) => {
    const show = window => window.showInactive()
    for (const window of BrowserWindow.getAllWindows()) show(window)
    app.on('browser-window-created', (_, window) => show(window))
    return process.getCreationTime()
  }) ?? before
  page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  const watch = () => page.evaluate(() => new Promise(resolve => {
    const seen = {}
    const look = () => {
      const now = performance.timeOrigin + performance.now()
      if (seen.editor === undefined && document.querySelector('.monaco-editor [role="textbox"]')) seen.editor = now
      if (seen.backend === undefined && document.querySelector('[title^="SQL backend: .NET"]')) seen.backend = now
      if (seen.editor === undefined || seen.backend === undefined) return
      finish()
    }
    const finish = () => {
      observer.disconnect()
      clearTimeout(timer)
      resolve({ ...seen, attached })
    }
    const observer = new MutationObserver(look)
    const attached = performance.timeOrigin + performance.now()
    // The failure's timer: what was seen by then says which mark never came.
    const timer = setTimeout(finish, 45000)
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] })
    look()
  }))
  // The window's first document gives way to the app's page; an observer that was in it goes with it.
  let marks
  for (let tries = 0; marks === undefined; tries++) {
    try { marks = await watch() } catch (error) { if (tries >= 5 || !/context was destroyed|navigation/i.test(String(error))) throw error }
  }
  if (marks.editor === undefined || marks.backend === undefined) throw new Error(`The workbench did not become ready: ${JSON.stringify(marks)} at ${page.url()}.`)
  await backendReady(page).waitFor({ timeout: 60000 })
  // A mark the observer found already there when it attached was not timed.
  const timed = at => at !== undefined && at > marks.attached + 1 ? at - created : undefined
  return { editor: timed(marks.editor), backend: timed(marks.backend) }
}

async function close() {
  if (!app) return
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  const closed = await within(app.close().then(() => true, () => false), 15000, () => false)
  if (!closed) app.process()?.kill('SIGKILL')
  app = undefined
}

try {
  // The first launch fills the profile (Chromium's caches, V8's code cache) and the disk cache; it is not timed.
  const runs = []
  for (let run = 0; run <= launches; run++) {
    step = `launch ${run}`
    const marks = await launch()
    if (run === 0) {
      const hello = await app.evaluate(() => globalThis.__variaTest.state())
      console.log(`Backend generation ${hello.generation}, ${hello.runtime} on ${hello.platform}.`)
    } else runs.push(marks)
    if (run < launches) await close()
  }
  const column = key => runs.map(run => run[key]).filter(value => value !== undefined)
  const editor = column('editor'), backend = column('backend')
  if (editor.length === launches) record('startup.editorMs', median(editor), 'ms', spread(editor))
  if (backend.length === launches) record('startup.backendReadyMs', median(backend), 'ms', spread(backend))
  const ready = runs.map(run => Math.max(run.editor ?? 0, run.backend ?? 0)).filter(value => value > 0)
  if (ready.length === launches) record('startup.readyMs', median(ready), 'ms', spread(ready))

  // The last launch stays open for the memory figures.
  step = 'idle memory'
  const idle = await settled()
  record('startup.idle.totalMb', mb(idle.total), 'MB', breakdown(idle))
  record('startup.idle.electronMb', mb(idle.electron), 'MB', 'main, renderer, GPU and utility processes')
  record('startup.idle.rendererMb', mb(idle.renderer), 'MB', 'the workbench page and its workers')
  record('startup.idle.backendMb', mb(idle.backend), 'MB', 'the .NET backend, no connection open')
  if (idle.hasPrivate) record('startup.idle.privateMb', mb(idle.private), 'MB', 'bytes no other process shares, the whole tree')

  step = 'query tabs'
  const tabsBefore = await documentTabSlots(page).count()
  for (let tab = 1; tab <= extraTabs; tab++) {
    await page.keyboard.press('ControlOrMeta+n')
    await documentTabSlots(page).nth(tabsBefore + tab - 1).waitFor({ state: 'attached' })
  }
  const tabs = await settled()
  record('startup.tabs.rendererMbPerTab', mb(tabs.renderer - idle.renderer) / extraTabs, 'MB', `${extraTabs} empty query tabs opened: renderer ${Math.round(mb(idle.renderer))} → ${Math.round(mb(tabs.renderer))} MB, the tree ${Math.round(mb(idle.total))} → ${Math.round(mb(tabs.total))} MB`)

  step = 'result memory'
  const w1 = await app.evaluate((_, rows) => globalThis.__variaTest.synthesize('W1', rows), resultRows)
  // Every row read once through the results worker, as a scroll to the end would, with the result left open.
  const read = await page.evaluate(async descriptor => {
    const handle = window.__variaResults.open(descriptor)
    let next = 0, rows = 0
    const lane = async () => {
      while (next < descriptor.rowsAvailable) {
        const first = next
        next += 4096
        const window_ = await handle.getWindow(first, 4096, { maxCellChars: 1024, textBudget: 4000000 })
        rows += window_.count
      }
    }
    await Promise.all([lane(), lane(), lane(), lane()])
    window.__benchResult = handle
    return rows
  }, w1)
  if (read !== resultRows) throw new Error(`W1 read incomplete: ${read} of ${resultRows} rows.`)
  const held = await settled()
  const stored = `${resultRows.toLocaleString('en-US')} W1 rows, ${Math.round(mb(w1.bytesStored))} MB of pages stored`
  record('startup.result.backendGrowthMb', mb(held.backend - tabs.backend), 'MB', `${stored}: backend ${Math.round(mb(tabs.backend))} → ${Math.round(mb(held.backend))} MB`)
  record('startup.result.backendPerStored', (held.backend - tabs.backend) / w1.bytesStored, '×', 'backend working set growth ÷ page bytes stored')
  record('startup.result.rendererGrowthMb', mb(held.renderer - tabs.renderer), 'MB', `${stored}, every row read once: renderer ${Math.round(mb(tabs.renderer))} → ${Math.round(mb(held.renderer))} MB`)
  record('startup.result.totalMb', mb(held.total), 'MB', breakdown(held))
  await page.evaluate(() => window.__benchResult.close())

  await writeFile(output, JSON.stringify({
    harness: 'startup', date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem(), live: false, metrics
  }, null, 2) + '\n')
  console.log(`Startup benchmarks written to ${output}.`)
} finally {
  clearTimeout(watchdog)
  await close()
  await rm(profile, { recursive: true, force: true })
}
