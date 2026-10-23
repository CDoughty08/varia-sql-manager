// Live views in the real app on the fake backend's debug.synthetic source (tests/fixtures/backend.mjs, workbench mode),
// through window.__variaLive: ticks arrive and are acknowledged one at a time; a hidden window pauses the view within
// 3 s and its frames stop; showing it resumes the view with a gap in its history; switching tabs pauses the tab's view;
// closing the owner tab ends its view; a killed backend reports the view lost, and Reconnect brings it back on the new
// connection. Smoke windows keep background throttling off, so the page is always visible to itself: the test hook
// stands in for minimizing.
import { electron, expect } from './fixtures/smoke.mjs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'live-profile-'))
const control = await mkdtemp(resolve('artifacts', 'live-control-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
let step = 'launch'
const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
const watchdog = setTimeout(() => { console.error(`Live suite timed out during: ${step}.`); app.process()?.kill(); process.exit(1) }, 300_000)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
page.on('pageerror', error => failures.push(error.message))

const live = (method, ...args) => page.evaluate(([name, values]) => window.__variaLive[name](...values), [method, args])
const frames = id => live('frames', id)
const snapshot = id => live('snapshot', id)
const calls = async () => (await readFile(join(control, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const liveCalls = async method => (await calls()).filter(call => call.method === method)
const backendState = () => app.evaluate(() => globalThis.__variaTest.state())
const sleep = ms => new Promise(done => setTimeout(done, ms))
const queryTabs = () => page.locator('.query-tabs').getByRole('tab')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
/** The view's ticks stay where they are for `ms`: nothing is sampled. */
async function stays(id, ms = 600) {
  const before = (await frames(id)).ticks
  await sleep(ms)
  expect((await frames(id)).ticks).toBe(before)
}
async function connect(password = 'live-smoke-password') {
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  if (!await dialog.isVisible()) await page.locator('.toolbar').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog.getByText('Loading saved connections…')).toHaveCount(0)
  await dialog.getByLabel('Server Name', { exact: true }).fill('live-server')
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('sql')
  await dialog.getByLabel('Login', { exact: true }).fill('reader')
  await dialog.getByLabel('Password', { exact: true }).fill(password)
  await dialog.getByLabel('Trust server certificate', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

try {
  await expect(page.locator('.status-bar')).toContainText('fake · Ready', { timeout: 30000 })
  await connect()
  await expect(page.locator('.query-context')).toContainText('live-server')
  // Background throttling is off in smoke runs, so the hidden window counts as visible: only the hook can hide it.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible')

  step = 'ticks'
  const id = await live('subscribeSynthetic', { tickMs: 50, rows: 5 })
  await expect.poll(async () => (await frames(id)).ticks).toBeGreaterThanOrEqual(5)
  const first = await snapshot(id)
  expect(first).toMatchObject({ status: 'live', subscriptionId: id })
  expect(Object.values(first.probes).map(probe => probe.state)).toEqual(['fresh', 'fresh', 'fresh'])
  // The tab's own connection, and each frame acknowledged in turn: seq goes up one at a time, and the stream keeps going.
  const subscribed = await liveCalls('live.subscribe')
  expect(subscribed).toHaveLength(1)
  expect(subscribed[0].params).toMatchObject({ subscriptionId: id, source: 'debug.synthetic', args: { tickMs: 50, rows: 5 } })
  const counted = await frames(id)
  expect(counted.lastSeq).toBe(counted.events - 1)
  await expect.poll(async () => (await live('table', id, 'debug.synthetic.table'))?.state).toBe('complete')
  expect((await live('table', id, 'debug.synthetic.table')).descriptor.rowsAvailable).toBe(5)
  expect((await live('ring', id, 'debug.synthetic.metrics')).length).toBeGreaterThanOrEqual(5)
  console.log('Live ticks passed: a view on the tab\'s connection, every frame applied and acknowledged in turn.')

  step = 'hidden window'
  const hiddenAt = Date.now()
  await live('setPageHidden', true)
  await expect.poll(async () => (await frames(id)).lastPatch, { timeout: 3000 }).toEqual({ paused: true })
  expect(Date.now() - hiddenAt).toBeLessThan(3000)
  await expect.poll(async () => (await snapshot(id)).status).toBe('paused')
  expect((await snapshot(id)).pausedBy).toBe('hidden')
  await sleep(200)
  await stays(id)
  const gaps = (await live('ring', id, 'debug.synthetic.metrics')).gaps
  await live('setPageHidden', false)
  await expect.poll(async () => (await frames(id)).lastPatch).toEqual({ paused: false })
  const resumed = (await frames(id)).ticks
  await expect.poll(async () => (await frames(id)).ticks).toBeGreaterThan(resumed + 2)
  expect((await snapshot(id)).status).toBe('live')
  // The first sample after the pause starts a new stretch of history.
  expect((await live('ring', id, 'debug.synthetic.metrics')).gaps).toBe(gaps + 1)
  expect((await liveCalls('live.update')).map(call => call.params.paused)).toEqual([true, false])
  console.log('Hidden window passed: paused within 3 s, no frames while hidden, resumed with a gap when shown.')

  step = 'tab switch'
  const owner = await page.evaluate(() => document.querySelector('.query-tabs [role="tab"][aria-selected="true"]')?.textContent)
  await page.keyboard.press(mod + '+N')
  await expect(queryTabs()).toHaveCount(2)
  await expect.poll(async () => (await snapshot(id)).status, { timeout: 5000 }).toBe('paused')
  await stays(id)
  await queryTabs().filter({ hasText: owner }).click()
  await expect.poll(async () => (await snapshot(id)).status).toBe('live')
  console.log('Tab switch passed: the view paused while its tab was not showing and resumed when it was.')

  step = 'close owner'
  // A second view owned by the new tab ends when that tab closes.
  await queryTabs().nth(1).click()
  const second = await live('subscribeSynthetic', { tickMs: 50, probes: ['debug.synthetic.status'] })
  await expect.poll(async () => (await frames(second))?.ticks ?? 0).toBeGreaterThanOrEqual(2)
  expect((await snapshot()).handles).toHaveLength(2)
  await page.keyboard.press(mod + '+W')
  await expect(queryTabs()).toHaveCount(1)
  await expect.poll(async () => (await snapshot()).handles.map(handle => handle.id)).toEqual([id])
  await expect.poll(() => page.evaluate(() => window.__variaResults.liveStreams)).toBe(1)
  await expect.poll(async () => (await snapshot(id)).status).toBe('live')
  console.log('Closing the owner tab passed: its view ended and released its stream; the other view kept going.')

  step = 'backend lost'
  const lostGeneration = (await backendState()).generation
  await app.evaluate(() => globalThis.__variaTest.kill())
  await expect.poll(async () => (await snapshot(id)).status, { timeout: 30000 }).toBe('lost')
  expect((await snapshot(id)).error.code).toMatch(/^(BACKEND_LOST|RESULT_UNAVAILABLE)$/)
  await expect.poll(async () => { const state = await backendState(); return state.status === 'ready' && state.generation > lostGeneration }, { timeout: 30000 }).toBe(true)
  // Nothing comes back by itself: the view's connection went with its backend.
  await sleep(500)
  expect((await snapshot(id)).status).toBe('lost')
  const history = (await live('ring', id, 'debug.synthetic.metrics')).length
  await page.locator('.backend-banner').getByRole('button', { name: 'Reconnect…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect', exact: true })
  await expect(dialog.getByLabel('Server Name', { exact: true })).toHaveValue('live-server')
  await dialog.getByLabel('Password', { exact: true }).fill('live-smoke-password')
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await snapshot(id)).status, { timeout: 15000 }).toBe('live')
  const back = await snapshot(id)
  expect(back.connectionId).not.toBe(first.connectionId)
  expect(back.subscriptionId).not.toBe(id)
  const resubscribed = await liveCalls('live.subscribe')
  expect(resubscribed.at(-1)).toMatchObject({ generation: lostGeneration + 1, params: { connectionId: back.connectionId, subscriptionId: back.subscriptionId } })
  await expect.poll(async () => (await live('ring', id, 'debug.synthetic.metrics')).length).toBeGreaterThan(history)
  console.log('Backend loss passed: the view reported lost, kept its history, and Reconnect resubscribed on the new connection.')

  await live('dispose', id)
  await expect.poll(() => page.evaluate(() => window.__variaResults.liveStreams)).toBe(0)
  expect(failures).toEqual([])
  console.log('Live views passed.')
} finally {
  clearTimeout(watchdog)
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await Promise.race([app.close(), sleep(15000).then(() => app.process()?.kill())]).catch(() => {})
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
