// A delayed native resize must finish before Tools > Options is opened by mnemonic.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { electron, expect } from './fixtures/smoke.mjs'
import { resizeContent, resizeWindow } from './fixtures/window-resize.mjs'
import { backendReady, editorTextbox, editorText } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'options-resize-profile-'))
const control = await mkdtemp(resolve('artifacts', 'options-resize-backend-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
let application, page
let stage = 'launch'
const failures = []
const watchdog = setTimeout(() => { console.error('Options resize regression exceeded two minutes.'); application?.process()?.kill(); process.exitCode = 1 }, 120000)
const tools = () => page.getByRole('menu', { name: 'Tools', exact: true })
const options = () => page.getByRole('dialog', { name: 'Options', exact: true })
const text = async () => (await editorText(page)).replaceAll('\u00a0', ' ')
const openTools = async () => {
  await editorTextbox(page).focus()
  await page.keyboard.press('Alt+t')
  await expect(tools().getByRole('menuitem', { name: 'Options…', exact: true })).toBeFocused()
}
// Capture the real native resize before application handlers see it, then replay it when the regression chooses.
const holdResize = () => page.evaluate(() => {
  const state = window.variaResizeGate = { held: false }
  const hold = event => { state.held = true; event.stopImmediatePropagation() }
  addEventListener('resize', hold, true)
  state.release = () => { removeEventListener('resize', hold, true); dispatchEvent(new Event('resize')) }
})
const held = () => page.evaluate(() => window.variaResizeGate.held)
const releaseResize = () => page.evaluate(() => window.variaResizeGate.release())
const replaceQuery = async () => {
  await editorTextbox(page).focus()
  await expect(editorTextbox(page)).toBeFocused()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1')
  await expect.poll(text).toBe('SELECT 1')
}

try {
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  page.on('pageerror', error => failures.push(error.message))
  stage = 'editor readiness'
  await expect(backendReady(page, 'fake')).toBeVisible({ timeout: 30000 })
  // The fake connection can be ready before React has mounted and bound Monaco's model.
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 30000 })
  stage = 'initial query input'
  await replaceQuery()
  // Both heights fit the CI display; establish a different size so every held transition has a native event.
  await resizeContent(application, page, 1024, 700)

  // The old viewport-only barrier lets Tools open before resize dismisses it; O then reaches the editor.
  stage = 'reproduce viewport-only barrier'
  await holdResize()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 740))
  await expect.poll(() => page.evaluate(() => innerHeight)).toBe(740)
  await expect.poll(held).toBe(true)
  await openTools()
  await releaseResize()
  await expect(tools()).toHaveCount(0)
  await page.keyboard.press('o')
  await expect.poll(text).toContain('o')
  await expect(options()).toHaveCount(0)
  console.log('Options resize regression reproduced: delayed resize dismisses Tools and sends O to the editor.')

  stage = 'verify resize event barrier'
  await replaceQuery()
  await holdResize()
  let completed = false
  const resized = resizeContent(application, page, 1024, 700).then(() => { completed = true })
  await expect.poll(held).toBe(true)
  await expect.poll(() => page.evaluate(() => innerHeight)).toBe(700)
  expect(completed, 'resizeContent waits for the application resize event even after the viewport changed').toBe(false)
  await releaseResize()
  await resized
  await openTools()
  await page.keyboard.press('o')
  await expect(options()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(options()).toHaveCount(0)
  await expect.poll(text).toBe('SELECT 1')
  // Repeating the same size has no native event and must still complete.
  stage = 'verify same-size completion'
  await resizeContent(application, page, 1024, 700)
  // A change of the outer size (object-actions-smoke's window) waits for the same event, which would close a menu opened
  // before it arrives. It grows, since the window is already at its minimum height.
  stage = 'verify outer-size barrier'
  const [outerWidth, outerHeight] = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  await holdResize()
  completed = false
  const resizedOuter = resizeWindow(application, page, outerWidth, outerHeight + 40).then(() => { completed = true })
  await expect.poll(held).toBe(true)
  await expect.poll(() => page.evaluate(() => innerHeight)).toBe(740)
  expect(completed, 'resizeWindow waits for the application resize event even after the viewport changed').toBe(false)
  await releaseResize()
  await resizedOuter
  await resizeWindow(application, page, outerWidth, outerHeight + 40)
  expect(failures).toEqual([])
  console.log('Options resize regression passed: the event barrier preserves the mnemonic and leaves the query unchanged.')
} catch (error) {
  const native = await application?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    contentSize: window.getContentSize(), focused: window.isFocused(), visible: window.isVisible(),
    rendererPid: window.webContents.getOSProcessId(), crashed: window.webContents.isCrashed()
  }))).catch(unavailable => ({ unavailable: unavailable.message }))
  const renderer = await page?.evaluate(() => ({
    readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
    viewport: [innerWidth, innerHeight], active: document.activeElement ? {
      tag: document.activeElement.tagName, role: document.activeElement.getAttribute('role'), label: document.activeElement.getAttribute('aria-label')
    } : null, resizeHeld: window.variaResizeGate?.held, resizeObserved: window.variaResizeObserved
  })).catch(unavailable => ({ unavailable: unavailable.message }))
  const diagnostic = { stage, failures, native, renderer, editor: {
    visible: await page?.locator('.monaco-editor').isVisible().catch(() => false),
    textboxFocused: page ? await editorTextbox(page).evaluate(element => element === document.activeElement).catch(() => false) : false,
    textLength: await text().then(value => value.length).catch(() => null)
  } }
  console.error('Options resize failure: ' + JSON.stringify(diagnostic))
  await writeFile(resolve('artifacts', 'options-resize-failure.json'), JSON.stringify(diagnostic, null, 2)).catch(() => {})
  await page?.screenshot({ path: resolve('artifacts', 'options-resize-failure.png') }).catch(() => {})
  throw error
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
