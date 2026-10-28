import { expect } from './smoke.mjs'

/** Native size changes precede the page's resize event, which closes menus. Wait for the event at the final size before
 *  sending menu keys; a window already at that size needs no event. The platform may clamp the requested bounds. */
export async function resizeContent(application, page, width, height) {
  const size = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  const before = await size()
  await page.evaluate(() => {
    window.variaResizeObserved = undefined
    window.variaResizeObserver = () => { window.variaResizeObserved = [innerWidth, innerHeight] }
    addEventListener('resize', window.variaResizeObserver)
  })
  try {
    await application.evaluate(({ BrowserWindow }, dimensions) => BrowserWindow.getAllWindows()[0].setContentSize(...dimensions), [width, height])
    await expect.poll(async () => {
      const [current, observed] = await Promise.all([size(), page.evaluate(() => window.variaResizeObserved)])
      return current[0] === before[0] && current[1] === before[1] || observed?.[0] === current[0] && observed[1] === current[1]
    }).toBe(true)
  } finally {
    await page.evaluate(() => { removeEventListener('resize', window.variaResizeObserver); delete window.variaResizeObserver; delete window.variaResizeObserved }).catch(() => {})
  }
}
