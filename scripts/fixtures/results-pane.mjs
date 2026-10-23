// Shared by results-smoke.mjs and grid-bench.mjs.
import { outputPane } from './ui.mjs'

/** Gives the output pane most of the window by dragging the sash above it up: the editor keeps a few lines. */
export async function enlargeOutput(page) {
  const outputTop = (await outputPane(page).boundingBox()).y
  const sash = (await Promise.all((await page.locator('.dv-split-view-container.dv-vertical > .dv-sash-container > .dv-sash:not(.dv-disabled)').all()).map(item => item.boundingBox())))
    .filter(box => box && box.y < outputTop).sort((a, b) => b.y - a.y)[0]
  await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2)
  await page.mouse.down()
  await page.mouse.move(sash.x + sash.width / 2, Math.max(150, sash.y - 300), { steps: 5 })
  await page.mouse.up()
}
