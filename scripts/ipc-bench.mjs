import { _electron as electron } from '@playwright/test'
import { cpus, totalmem } from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { statusBar } from './fixtures/ui.mjs'

// End-to-end IPC benchmarks (npm run bench:e2e): the built app with the Release backend and its test hooks, measured
// from the renderer. --live adds a real query against VARIA_TEST_SQL_SERVER. Writes artifacts/bench/e2e.json, which
// scripts/check-bench.mjs compares with tests/bench/floors.json. Needs the Release backend and out/ (npm run check).
const live = process.argv.includes('--live')
const liveUser = process.env.VARIA_TEST_SQL_USER?.trim() ? process.env.VARIA_TEST_SQL_USER : undefined
if (live && !process.env.VARIA_TEST_SQL_SERVER) throw new Error('--live needs VARIA_TEST_SQL_SERVER (and VARIA_TEST_SQL_USER and VARIA_TEST_SQL_PASSWORD for SQL authentication).')
if (live && liveUser && process.env.VARIA_TEST_SQL_PASSWORD === undefined) throw new Error('VARIA_TEST_SQL_PASSWORD is required when VARIA_TEST_SQL_USER is set.')
const output = resolve('artifacts/bench/e2e.json')
await mkdir(resolve('artifacts/bench'), { recursive: true })
await rm(output, { force: true })
const profile = await mkdtemp(resolve('artifacts', 'bench-profile-'))
const metrics = {}
let app
let page
let step = 'launch'
const watchdog = setTimeout(() => { console.error(`IPC benchmarks timed out during: ${step}.`); app?.process()?.kill(); process.exit(1) }, 600000)

function record(id, value, unit, detail) {
  metrics[id] = { value, unit, ...detail ? { detail } : {} }
  console.log(`${id}: ${Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : Number(value.toPrecision(3))} ${unit}${detail ? ` (${detail})` : ''}`)
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.max(0, Math.ceil(p / 100 * values.length) - 1))]

/** Reads every row of a stored result through window.__variaResults (the results worker), with a few windows in
 *  flight, while watching the UI thread: long tasks, animation-frame gaps, and a timer heartbeat. */
function readAll(descriptor, o) {
  return page.evaluate(async ({ descriptor, o }) => {
    const longTasks = []
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration)) })
    observer.observe({ type: 'longtask' })
    let frames = 0, frameGap = 0, timerGap = 0, running = true
    let lastFrame = performance.now(), lastTick = performance.now()
    const frame = now => { frames++; frameGap = Math.max(frameGap, now - lastFrame); lastFrame = now; if (running) requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
    const tick = () => { const now = performance.now(); timerGap = Math.max(timerGap, now - lastTick); lastTick = now; if (running) setTimeout(tick, 16) }
    setTimeout(tick, 16)
    // Let the frame loop settle before measuring.
    await new Promise(done => setTimeout(done, 200))
    lastFrame = performance.now(); frameGap = 0
    const handle = window.__variaResults.open(descriptor)
    const coldStart = performance.now()
    const cold = await handle.getWindow(0, 100, { maxCellChars: o.maxCellChars })
    const firstWindowMs = performance.now() - coldStart
    const started = performance.now()
    let next = 0, rows = 0, cells = 0, cut = 0
    const lane = async () => {
      while (next < descriptor.rowsAvailable) {
        const first = next
        next += o.windowRows
        const window_ = await handle.getWindow(first, o.windowRows, { maxCellChars: o.maxCellChars, textBudget: 4000000 })
        rows += window_.count
        cells += window_.text.length
        for (const flag of window_.flags) if (flag & 10) cut++
      }
    }
    await Promise.all([lane(), lane(), lane(), lane()])
    const elapsed = performance.now() - started
    running = false
    await new Promise(done => setTimeout(done, 50))
    observer.disconnect()
    await handle.close()
    return { rows, cells, cut, coldRows: cold.count, firstWindowMs, elapsed, longTasks, frames, frameGap, timerGap }
  }, { descriptor, o })
}

try {
  const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_BACKEND_TEST_HOOKS: '1', VARIA_RESULT_BUDGET_BYTES: String(1024 * 1024 * 1024) }
  delete env.ELECTRON_RUN_AS_NODE
  // Playwright adds --no-sandbox on Linux unless chromiumSandbox is set; only root (cloud sessions) needs it.
  app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await app.firstWindow()
  page.setDefaultTimeout(60000)
  // Smoke windows stay hidden, and a hidden window gets about one animation frame a second; show it without focus.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].showInactive() })
  await statusBar(page).getByText(/· Ready/).waitFor({ timeout: 60000 })
  const hello = await app.evaluate(() => globalThis.__variaTest.state())
  console.log(`Backend generation ${hello.generation}, ${hello.runtime} on ${hello.platform}.`)

  step = 'invoke round trip'
  const invoke = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) await window.varia.health()
    const samples = []
    for (let i = 0; i < 1000; i++) {
      const started = performance.now()
      const result = await window.varia.health()
      samples.push(performance.now() - started)
      if (!result.ok) throw new Error(result.error)
    }
    return samples
  })
  record('e2e.invoke.p50Ms', percentile(invoke, 50), 'ms', '1,000 sequential window.varia.health() calls')
  record('e2e.invoke.p99Ms', percentile(invoke, 99), 'ms', '1,000 sequential window.varia.health() calls')

  step = 'live tick round trip'
  // The backend's debug.synthetic source every 10 ms, each event acknowledged 20 ms after it arrived: the next sample is
  // overdue when its credit reaches the backend, so the time from the acknowledgement to the next event at the page is
  // the whole loop (page → results worker → main → backend → main → worker → page), not the source's schedule.
  const liveTick = await page.evaluate(async () => {
    const samples = []
    let ackedAt = 0, events = 0, finish
    const finished = new Promise(resolve => { finish = resolve })
    const params = { subscriptionId: crypto.randomUUID(), connectionId: crypto.randomUUID(), source: 'debug.synthetic', probes: [{ probe: 'debug.synthetic.metrics', intervalMs: 1000 }], args: { tickMs: 10 } }
    const stream = window.__variaResults.live(params, (event, bytes) => {
      if (++events > 5 && ackedAt > 0) samples.push(performance.now() - ackedAt)
      if (samples.length >= 500) return finish()
      setTimeout(() => { ackedAt = performance.now(); stream.ack(bytes) }, 20)
    })
    const early = await Promise.race([finished.then(() => undefined), stream.done])
    stream.cancel()
    return { samples, early, end: await stream.done }
  })
  if (liveTick.early) throw new Error(`The live stream ended early: ${JSON.stringify(liveTick.early)}`)
  if (!liveTick.end.ok || liveTick.end.value.ended !== 'cancelled') throw new Error(`The live stream did not end cancelled: ${JSON.stringify(liveTick.end)}`)
  record('e2e.liveData.tickP50Ms', percentile(liveTick.samples, 50), 'ms', `${liveTick.samples.length} ticks of debug.synthetic`)
  record('e2e.liveData.tickP99Ms', percentile(liveTick.samples, 99), 'ms', `${liveTick.samples.length} ticks of debug.synthetic`)

  step = 'W1 into the results worker'
  const w1 = await app.evaluate(() => globalThis.__variaTest.synthesize('W1', 500000))
  const w1Read = await readAll(w1, { windowRows: 4096, maxCellChars: 1024 })
  if (w1Read.rows !== 500000 || w1Read.cells !== 500000 * w1.columns.length || w1Read.cut !== 0 || w1Read.coldRows !== 100) throw new Error('W1 read incomplete: ' + JSON.stringify({ ...w1Read, longTasks: undefined }))
  const w1Detail = `${(w1.bytesStored / 1048576).toFixed(0)} MiB stored, ${Math.round(w1Read.elapsed)} ms`
  record('e2e.w1.rowsPerSecond', w1Read.rows / (w1Read.elapsed / 1000), 'rows/s', w1Detail)
  record('e2e.w1.mbPerSecond', w1.bytesStored / 1e6 / (w1Read.elapsed / 1000), 'MB/s', w1Detail)
  record('e2e.firstWindowMs', w1Read.firstWindowMs, 'ms', 'first 100-row window of a stored result, cold worker cache')
  record('e2e.w1.longTasks', w1Read.longTasks.filter(duration => duration > 50).length, 'tasks', `UI long tasks over 50 ms: ${JSON.stringify(w1Read.longTasks)}`)
  const framed = w1Read.frames >= w1Read.elapsed / 100
  record('e2e.w1.maxFrameGapMs', framed ? w1Read.frameGap : w1Read.timerGap, 'ms', framed ? `${w1Read.frames} animation frames` : `timer heartbeat; only ${w1Read.frames} animation frames`)

  step = 'B1 into the results worker'
  const b1 = await app.evaluate(() => globalThis.__variaTest.synthesize('B1', 20000))
  const b1Read = await readAll(b1, { windowRows: 400, maxCellChars: 65535 })
  if (b1Read.rows !== 20000 || b1Read.cut !== 0) throw new Error('B1 read incomplete: ' + JSON.stringify({ ...b1Read, longTasks: undefined }))
  record('e2e.b1.mbPerSecond', b1.bytesStored / 1e6 / (b1Read.elapsed / 1000), 'MB/s', `${(b1.bytesStored / 1048576).toFixed(0)} MiB stored, ${Math.round(b1Read.elapsed)} ms`)

  if (live) {
    step = 'live ingest'
    const options = { server: process.env.VARIA_TEST_SQL_SERVER, database: 'master', authentication: liveUser ? 'sql' : 'windows', username: liveUser, password: liveUser ? process.env.VARIA_TEST_SQL_PASSWORD : undefined, trustServerCertificate: true }
    // A W1-like million rows from a cross join that every version from 2016 has, cheap for the server to produce, so the
    // backend's reading and storing is what is measured; maxRows 0 stores up to the memory budget.
    const select = top => `SELECT TOP (${top}) a.object_id AS id, CAST(a.name AS nvarchar(50)) AS name,
  CAST(DATEADD(SECOND, b.object_id % 86400, '2026-01-01') AS datetime2(7)) AS created, CAST(a.object_id % 100000 AS decimal(18,2)) AS amount,
  CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier) AS [key],
  CAST(N'Note: ' + b.name + N' Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor' AS nvarchar(200)) AS note,
  CAST(a.object_id % 2 AS bit) AS active, CASE WHEN b.object_id % 5 = 0 THEN NULL ELSE b.object_id % 1000 END AS score
FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;`
    const ingest = await page.evaluate(async ({ options, warmUp, sql }) => {
      const connected = await window.varia.connect(options)
      if (!connected.ok) throw new Error(connected.error)
      const results = window.__variaResults
      const queryId = crypto.randomUUID(), sessionId = crypto.randomUUID()
      // A first, smaller run warms up the server's plan cache and the backend's code paths; its results are released by the next execution.
      const first = await window.varia.execute({ connectionId: connected.value.id, sessionId, database: 'master', sql: warmUp, queryId: crypto.randomUUID(), maxRows: 0, timeoutSeconds: 600, maxResultSets: 10 })
      if (!first.ok) throw new Error(first.error)
      let opened, handle, firstWindowMs, trying = false
      const subscription = results.onQueryEvent(queryId, async event => {
        if (event.type === 'resultSet.opened' && !opened) { opened = performance.now(); handle = results.open(event.descriptor) }
        if (!handle || firstWindowMs !== undefined || trying || handle.getSnapshot().rowsAvailable < 100) return
        trying = true
        const window_ = await handle.getWindow(0, 100).catch(() => undefined)
        if (window_?.count === 100 && firstWindowMs === undefined) firstWindowMs = performance.now() - opened
        trying = false
      })
      const started = performance.now()
      const result = await window.varia.execute({ connectionId: connected.value.id, sessionId, database: 'master', sql, queryId, maxRows: 0, timeoutSeconds: 600, maxResultSets: 10 })
      const elapsed = performance.now() - started
      subscription.dispose()
      if (!result.ok) throw new Error(result.error)
      const summary = result.value
      for (const descriptor of summary.resultSets) await results.open(descriptor).close()
      await window.varia.closeQuerySession(sessionId)
      await window.varia.disconnect(connected.value.id)
      return { status: summary.status, error: summary.error?.message, sets: summary.resultSets.map(set => ({ rowsRead: set.rowsRead, rowsStored: set.rowsStored, truncated: set.truncated })), elapsedMs: summary.elapsedMs, invokeMs: elapsed, firstWindowMs }
    }, { options, warmUp: select(100000), sql: select(1000000) })
    const set = ingest.sets[0]
    if (ingest.status !== 'completed' || set?.rowsStored !== 1000000) throw new Error('Live ingest incomplete: ' + JSON.stringify(ingest))
    record('e2e.live.rowsPerSecond', set.rowsRead / (ingest.elapsedMs / 1000), 'rows/s', `${set.rowsRead.toLocaleString('en-US')} rows stored in ${ingest.elapsedMs} ms (backend), ${Math.round(ingest.invokeMs)} ms end to end`)
    if (ingest.firstWindowMs !== undefined) record('e2e.live.firstWindowMs', ingest.firstWindowMs, 'ms', 'first 100-row window after resultSet.opened')

    // A small script in a warm tab, end to end: the execution floor. Nothing runs in the session after the script (its
    // transaction is read only when it is about to end), so this is one round trip.
    step = 'live small execute'
    const small = await page.evaluate(async ({ options, runs }) => {
      const connected = await window.varia.connect(options)
      if (!connected.ok) throw new Error(connected.error)
      const sessionId = crypto.randomUUID(), times = [], scripts = []
      for (let run = 0; run < runs + 5; run++) {
        const started = performance.now()
        const result = await window.varia.execute({ connectionId: connected.value.id, sessionId, database: 'master', sql: 'SELECT 1;', queryId: crypto.randomUUID(), maxRows: 0, timeoutSeconds: 30, maxResultSets: 10 })
        const elapsed = performance.now() - started
        if (!result.ok || result.value.status !== 'completed' || 'transactionCount' in result.value || !result.value.spid) throw new Error('Small execute failed: ' + JSON.stringify(result))
        for (const descriptor of result.value.resultSets) await window.__variaResults.open(descriptor).close()
        // The first runs open the session and warm both sides up.
        if (run >= 5) { times.push(elapsed); scripts.push(result.value.elapsedMs) }
      }
      await window.varia.closeQuerySession(sessionId)
      await window.varia.disconnect(connected.value.id)
      return { times, scripts }
    }, { options, runs: 200 })
    record('e2e.live.smallExecuteP50Ms', percentile(small.times, 50), 'ms', `SELECT 1 in a warm tab, p50 of ${small.times.length}; p99 ${percentile(small.times, 99).toFixed(1)} ms; backend's script time p50 ${percentile(small.scripts, 50)} ms`)
  }

  await writeFile(output, JSON.stringify({
    harness: 'e2e', date: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
    cpus: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', memoryBytes: totalmem(), live, metrics
  }, null, 2) + '\n')
  console.log(`IPC benchmarks written to ${output}.`)
} finally {
  clearTimeout(watchdog)
  if (app) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
    const closed = await Promise.race([app.close().then(() => true, () => false), new Promise(done => setTimeout(() => done(false), 15000))])
    if (!closed) app.process()?.kill('SIGKILL')
  }
  await rm(profile, { recursive: true, force: true })
}
