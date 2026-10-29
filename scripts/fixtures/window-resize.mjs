import { expect } from './smoke.mjs'

/** Native size changes precede the page's resize event, which closes menus. Wait for the event at the final size before
 *  sending menu keys or opening a menu; a window already at that size needs no event. The platform may clamp the
 *  requested bounds. `setter` is the BrowserWindow method that takes the new width and height. */
async function resize(application, page, setter, width, height) {
  const size = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  const before = await size()
  await page.evaluate(() => {
    window.variaResizeObserved = undefined
    window.variaResizeObserver = () => { window.variaResizeObserved = [innerWidth, innerHeight] }
    addEventListener('resize', window.variaResizeObserver)
  })
  try {
    await application.evaluate(({ BrowserWindow }, [method, dimensions]) => { BrowserWindow.getAllWindows()[0][method](...dimensions) }, [setter, [width, height]])
    await expect.poll(async () => {
      const [current, observed] = await Promise.all([size(), page.evaluate(() => window.variaResizeObserved)])
      return current[0] === before[0] && current[1] === before[1] || observed?.[0] === current[0] && observed[1] === current[1]
    }).toBe(true)
  } finally {
    await page.evaluate(() => { removeEventListener('resize', window.variaResizeObserver); delete window.variaResizeObserver; delete window.variaResizeObserved }).catch(() => {})
  }
}

/** Sets the window's content (page) size and waits for the page's resize event. */
export const resizeContent = (application, page, width, height) => resize(application, page, 'setContentSize', width, height)

/** Sets the window's outer size, frame included, and waits for the page's resize event. */
export const resizeWindow = (application, page, width, height) => resize(application, page, 'setSize', width, height)
