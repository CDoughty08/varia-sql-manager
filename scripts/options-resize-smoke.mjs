// A delayed native resize must finish before Tools > Options is opened by mnemonic.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { electron, expect } from './fixtures/smoke.mjs'
import { resizeContent } from './fixtures/window-resize.mjs'
import { editorTextbox, editorText } from './fixtures/ui.mjs'

await mkdir('artifacts', { recursive: true })
const profile = await mkdtemp(resolve('artifacts', 'options-resize-profile-'))
const control = await mkdtemp(resolve('artifacts', 'options-resize-backend-'))
const env = { ...process.env, VARIA_SMOKE_TEST: '1', VARIA_TEST_USER_DATA: profile, VARIA_TEST_BACKEND: 'workbench', VARIA_TEST_NODE: process.execPath, VARIA_TEST_BACKEND_DIR: control }
delete env.ELECTRON_RUN_AS_NODE
let application, page
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
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText('SELECT 1')
  await expect.poll(text).toBe('SELECT 1')
}

try {
  application = await electron.launch({ args: ['.'], env, chromiumSandbox: process.getuid?.() !== 0 })
  page = await application.firstWindow()
  await expect(page.getByText('fake · Ready')).toBeVisible({ timeout: 30000 })
  await replaceQuery()
  // Both heights fit the CI display; establish a different size so every held transition has a native event.
  await resizeContent(application, page, 1024, 700)

  // The old viewport-only barrier lets Tools open before resize dismisses it; O then reaches the editor.
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
  await resizeContent(application, page, 1024, 700)
  console.log('Options resize regression passed: the event barrier preserves the mnemonic and leaves the query unchanged.')
} finally {
  clearTimeout(watchdog)
  await application?.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await application?.close().catch(() => application?.process()?.kill())
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  await rm(control, { recursive: true, force: true }).catch(() => {})
}
