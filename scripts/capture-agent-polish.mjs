// Playwright-over-Electron live screenshot capture harness for SQL Server Agent polish lanes (AP-1..AP-6).
// Usage: node scripts/capture-agent-polish.mjs --lane <ap-1|ap-2|ap-3|ap-4|ap-5|ap-6> [--out <dir>]
import { captureAp4 } from './capture-agent-polish-lanes/ap4.mjs'
import { electron, expect } from './fixtures/smoke.mjs'
import { chooseExplorerMenuItem } from './fixtures/explorer-tree.mjs'
import {
  chooseJamMoreAction, connectDialogWindow, documentFrame, documentTab, gridPart, jamToolbar, liveGrid, quickInputRows, statusBar, submitConnect, toolbarButton
} from './fixtures/ui.mjs'
import { captureAp3 } from './capture-agent-polish-lanes/ap3.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { captureAp2 } from './capture-agent-polish-lanes/ap2.mjs'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const validLanes = ['ap-1', 'ap-2', 'ap-3', 'ap-4', 'ap-5', 'ap-6']
const viewports = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1080x720', width: 1080, height: 720 }
]
const themes = ['dark', 'light']

function readArgValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || !value.trim() || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`)
  return value
}

function parseArgs(argv) {
  let lane
  let out
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--lane') {
      lane = readArgValue(argv, index, '--lane')
      index++
    } else if (arg.startsWith('--lane=')) {
      lane = arg.slice('--lane='.length)
      if (!lane.trim()) throw new Error('Missing value for --lane.')
    } else if (arg === '--out') {
      out = readArgValue(argv, index, '--out')
      index++
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length)
      if (!out.trim()) throw new Error('Missing value for --out.')
    } else if (arg === '--help' || arg === '-h') return { help: true }
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return { lane, out, help: false }
}

function usage() {
  console.error('Usage: node scripts/capture-agent-polish.mjs --lane <ap-1|ap-2|ap-3|ap-4|ap-5|ap-6> [--out <dir>]')
}

async function setTheme(page, mode) {
  await page.evaluate(theme => window.varia.setThemePreference({ mode: theme }), mode)
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe(mode)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
}

async function captureMatrix(app, page, outDir, name) {
  for (const viewport of viewports) {
    await resizeContent(app, page, viewport.width, viewport.height)
    for (const theme of themes) {
      await setTheme(page, theme)
      const path = join(outDir, `${name}-${viewport.label}-${theme}.png`)
      await page.screenshot({ path })
      console.log(`Captured ${path}`)
    }
  }
  await setTheme(page, 'dark')
  await resizeContent(app, page, 1440, 900)
}

async function launchMainApp(profile, control) {
  const env = {
    ...process.env,
    VARIA_SMOKE_TEST: '1',
    VARIA_TEST_USER_DATA: profile,
    VARIA_TEST_BACKEND: 'workbench',
    VARIA_TEST_NODE: process.execPath,
    VARIA_TEST_BACKEND_DIR: control
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  return { app, page }
}

async function connectFakeServer(app, page, server = 'server-a') {
  await expect(statusBar(page)).toContainText(/Ready/, { timeout: 30000 })
  await toolbarButton(page, 'Connect').click()
  const { window, dialog } = await connectDialogWindow(app)
  await dialog.getByLabel('Server Name', { exact: true }).fill(server)
  await dialog.getByLabel('Authentication', { exact: true }).selectOption('windows')
  await submitConnect(window, dialog, { timeout: 30000 })
}

async function captureResizableSplitFixture(outDir, profile) {
  const fixtureDir = resolve('artifacts', 'agent-polish-split-fixture')
  await build({
    configFile: false,
    root: resolve('tests/fixtures/resizable-split'),
    base: './',
    logLevel: 'error',
    plugins: [react()],
    build: { outDir: fixtureDir, emptyOutDir: true, minify: false }
  })
  const env = {
    ...process.env,
    VARIA_SPLIT_FIXTURE_DIR: fixtureDir,
    VARIA_SPLIT_FIXTURE_QUERY: 'theme=dark',
    VARIA_TEST_USER_DATA: profile
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    args: [resolve('tests/fixtures/resizable-split/main.cjs')],
    env,
    chromiumSandbox: process.getuid?.() !== 0
  })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    const sash = page.getByRole('separator', { name: 'Resize steps rail', exact: true })
    await expect(sash).toBeVisible()
    // Drag wider (+56 px) and keep pointer hovering on the separator so hover/resized state shows cleanly.
    const box = await sash.boundingBox()
    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + 56, startY, { steps: 6 })
    await page.mouse.up()
    await expect(sash).toHaveAttribute('aria-valuenow', '360')
    for (const viewport of viewports) {
      await resizeContent(app, page, viewport.width, viewport.height)
      const moved = await sash.boundingBox()
      await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2)
      for (const theme of themes) {
        await page.evaluate(mode => window.__setFixtureTheme(mode), theme)
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeType)).toBe(theme)
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        const path = join(outDir, `06-resizable-split-sash-${viewport.label}-${theme}.png`)
        await page.screenshot({ path })
        console.log(`Captured ${path}`)
      }
    }
  } finally {
    await app.close().catch(() => {})
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function captureAp1(outDir, profile) {
  const control = await mkdtemp(resolve('artifacts', 'agent-polish-backend-'))
  await writeFile(resolve(control, 'agent-node'), '')
  await writeFile(resolve(control, 'agent-operator-jobs'), '')
  const { app, page } = await launchMainApp(profile, control)
  const jobCell = name => liveGrid(page, 'Jobs').locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: new RegExp(`^${name}$`) }) }).locator(gridPart.cell).nth(2)
  let closedMain = false
  try {
    await connectFakeServer(app, page)
    await chooseExplorerMenuItem(page, ['server-a', 'SQL Server Agent'], 'Job Activity Monitor')
    await expect(jobCell('Nightly')).toBeVisible()

    // 1. Log File Viewer layout (.lfv-* namespace after collision split).
    await jobCell('Nightly').click()
    await chooseJamMoreAction(page, documentFrame(page, 'Job Activity Monitor'), 'View history')
    await expect(documentTab(page, 'Log File Viewer - server-a')).toHaveAttribute('aria-selected', 'true')
    const viewer = documentFrame(page, 'Log File Viewer')
    const runs = liveGrid(page, 'Runs')
    await expect(runs).toContainText('Nightly')
    await runs.locator(gridPart.row, { has: page.locator(gridPart.cell, { hasText: /^Nightly$/ }) }).first().locator(gridPart.cell).nth(1).click()
    await expect(viewer.getByRole('region', { name: 'Message details', exact: true })).toContainText('The last step to run was step 2 (Load).')
    await captureMatrix(app, page, outDir, '01-lfv-layout')

    // 2. Job Document Alerts (.agent-table) & 3. History (.agent-job-history-* + .agent-table).
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await jobCell('Nightly').dblclick()
    await expect(documentTab(page, 'Job Properties - Nightly')).toHaveAttribute('aria-selected', 'true')
    const jobFrame = documentFrame(page, 'Nightly')
    await jobFrame.getByRole('button', { name: 'Alerts', exact: true }).click()
    await expect(jobFrame.getByRole('table', { name: 'Alerts that run this job', exact: true })).toContainText('Nightly failed')
    await captureMatrix(app, page, outDir, '02-job-alerts-table')

    await jobFrame.getByRole('button', { name: 'History', exact: true }).click()
    const historyGroup = jobFrame.getByRole('group', { name: 'History', exact: true })
    await expect(historyGroup.getByRole('table', { name: 'Steps of the selected run', exact: true })).toContainText('Truncate')
    await captureMatrix(app, page, outDir, '03-job-history-table')

    // 4. AgentJobStatus status bar item.
    await documentTab(page, 'Job Activity Monitor - server-a').click()
    await jobCell('Backup').click()
    await jamToolbar(documentFrame(page, 'Job Activity Monitor')).getByRole('button', { name: 'Start', exact: true }).click()
    await expect(statusBar(page).getByRole('button', { name: 'Dismiss Backup', exact: true })).toBeVisible()
    await captureMatrix(app, page, outDir, '04-status-bar-agent-job')

    // 5. OperatorsDocument flex fix (<JobsTable /> below <SidePane /> + .agent-table).
    await page.keyboard.press('F1')
    await page.keyboard.type('Operators and Notifications')
    await quickInputRows(page).filter({ hasText: 'Operators and Notifications' }).first().click()
    await expect(documentTab(page, 'Operators and Notifications')).toHaveAttribute('aria-selected', 'true')
    const opsFrame = documentFrame(page, 'Operators and notifications')
    const jobsRegion = opsFrame.getByRole('region', { name: 'Jobs that notify operators', exact: true })
    await expect(jobsRegion).toBeVisible()
    const sideBox = await opsFrame.getByRole('complementary').boundingBox()
    const jobsBox = await jobsRegion.boundingBox()
    expect(jobsBox.y, 'Jobs that notify operators sits below the selected operator side pane').toBeGreaterThanOrEqual(sideBox.y + sideBox.height - 1)
    await captureMatrix(app, page, outDir, '05-operators-jobs-table')

    await app.close()
    closedMain = true

    // 6. ResizableSplit fixture hover/drag state in Electron.
    await captureResizableSplitFixture(outDir, profile)
  } finally {
    if (!closedMain) await app.close().catch(() => {})
    await rm(control, { recursive: true, force: true }).catch(() => {})
  }
}

const lanes = {
  'ap-1': captureAp1,
  'ap-2': (outDir, profile) => captureAp2({ outDir, profile, launchMainApp, connectFakeServer, captureMatrix, expect }),
  'ap-3': (outDir, profile) => captureAp3(outDir, profile, { launchMainApp, connectFakeServer, captureMatrix }),
  'ap-4': captureAp4
}
}
const implementedLanes = new Set(Object.keys(lanes))

let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  usage()
  process.exit(1)
}
if (parsed.help) {
  usage()
  process.exit(0)
}
if (!parsed.lane || !validLanes.includes(parsed.lane)) {
  console.error(parsed.lane ? `Unknown lane: ${parsed.lane}.` : 'Missing required --lane argument.')
  usage()
  process.exit(1)
}
if (!implementedLanes.has(parsed.lane)) {
  console.error(`Lane ${parsed.lane} capture will be implemented in ${parsed.lane.toUpperCase()}.`)
  process.exit(1)
}
if (!existsSync(resolve('out/main/index.js'))) {
  console.error('Missing built Electron app (out/main/index.js). Run "npm run build:smoke" first.')
  process.exit(1)
}

const outDir = resolve(parsed.out ?? join('artifacts', 'agent-polish', parsed.lane))
await mkdir('artifacts', { recursive: true })
await mkdir(outDir, { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'agent-polish-profile-'))
const watchdog = setTimeout(() => {
  console.error(`Capture lane ${parsed.lane} exceeded its time limit.`)
  process.exit(1)
}, 300000)

try {
  await lanes[parsed.lane](outDir, profile, { captureMatrix, launchMainApp, connectFakeServer, viewports, themes })
} finally {
  clearTimeout(watchdog)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
