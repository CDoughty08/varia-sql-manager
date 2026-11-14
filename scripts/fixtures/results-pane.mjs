// Shared by the results smoke suites and grid-bench.mjs.
import { outputPane, part } from './ui.mjs'

/** The box of Dockview's sash right above the output pane, the one between it and the query editor. */
async function outputSash(page) {
  const outputTop = (await outputPane(page).boundingBox()).y
  return (await Promise.all((await page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash:not(.dv-disabled)').all()).map(item => item.boundingBox())))
    .filter(box => box && box.y < outputTop).sort((a, b) => b.y - a.y)[0]
}

/** Drags that sash from its middle to `y`. */
async function dragOutputSash(page, sash, y) {
  await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2)
  await page.mouse.down()
  await page.mouse.move(sash.x + sash.width / 2, y, { steps: 5 })
  await page.mouse.up()
}

/** Gives the output pane most of the window by dragging the sash above it up: the editor keeps a few lines. */
export async function enlargeOutput(page) {
  const sash = await outputSash(page)
  await dragOutputSash(page, sash, Math.max(150, sash.y - 300))
}

/**
 * Makes the results stack `height` pixels tall by dragging the sash above the output pane, the editor taking the rest.
 * What the stack gets at a given window size depends on the first window's size, whose split Reset restores, and on the
 * window chrome, which differ between machines. Returns the stack's height: within a pixel of `height` unless a pane's
 * minimum stopped the sash.
 */
export async function sizeResultStack(page, height) {
  const stackHeight = () => page.locator(part.resultStack).evaluate(stack => stack.clientHeight)
  let current = await stackHeight()
  for (let attempt = 0; attempt < 3 && Math.abs(current - height) > 1; attempt++) {
    const sash = await outputSash(page)
    await dragOutputSash(page, sash, sash.y + sash.height / 2 + current - height)
    current = await stackHeight()
  }
  return current
}

/**
 * Pins the results layout to Stacked (queryResults.grid.layout), for suites whose steps find results by their stacked
 * captions, splitters and several grids at once. Stacked is the default until the overflow picker lands; the pin keeps
 * those suites on it after Tabs becomes the default. The grouped-results suite covers Tabs.
 */
export async function pinStackedResults(page) {
  const result = await page.evaluate(() => window.varia.updateSettings({ 'queryResults.grid.layout': 'stacked' }))
  if (!result.ok) throw new Error(result.error)
}
