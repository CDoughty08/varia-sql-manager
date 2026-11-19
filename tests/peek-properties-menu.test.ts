// @vitest-environment happy-dom
// Peek Properties' Copy: the selected facts, else all; a menu opened while a press is down reads the selection as the press
// began (macOS selects the word under a right-click first), and once the press ends it reads the selection live (Shift+F10).
import { afterEach, describe, expect, it } from 'vitest'
import { propertiesMenu } from '../src/renderer/src/explorer/PeekCard'

function pane() {
  const element = document.createElement('div')
  element.innerHTML = '<dl><div class="peek-fact"><dt>Schema</dt><dd>dbo</dd></div><div class="peek-fact"><dt>Row count</dt><dd>12,345</dd></div>'
    + '<div class="peek-fact"><dt>Data space</dt><dd>2.00 MB</dd></div></dl>'
  document.body.append(element)
  return element
}
function select(element: Element) {
  const range = document.createRange()
  range.selectNodeContents(element)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
}
const fact = (element: HTMLElement, label: string) => [...element.querySelectorAll('dt')].find(dt => dt.textContent === label)!

afterEach(() => { getSelection()?.removeAllRanges(); document.body.replaceChildren() })

describe('Peek Properties menu', () => {
  it('copies the selected facts, else every fact, and nothing before the facts load', () => {
    const element = pane(), menu = propertiesMenu(false)
    expect(menu.target(element)?.text).toBe('Schema\tdbo\nRow count\t12,345\nData space\t2.00 MB')
    select(fact(element, 'Row count'))
    expect(menu.target(element)).toEqual({ kind: 'peekProperties', text: 'Row count\t12,345' })
    expect(propertiesMenu(true).target(element)?.text).toBe('Row count\t12,345')
    expect(menu.target(document.createElement('div'))).toBeNull()
  })

  it('reads the selection as a press began while it is down, then live once it ends', () => {
    const element = pane(), menu = propertiesMenu(false)
    // A right-click with nothing selected, which selects the word under it before the menu opens: every fact.
    menu.press(element)
    select(fact(element, 'Row count'))
    expect(menu.target(element)?.text).toBe('Schema\tdbo\nRow count\t12,345\nData space\t2.00 MB')
    // A drag that selects, then the menu from the keyboard once the press has ended: the selection as it is.
    getSelection()!.removeAllRanges()
    menu.press(element)
    select(fact(element, 'Data space'))
    document.dispatchEvent(new Event('pointerup'))
    expect(menu.target(element)?.text).toBe('Data space\t2.00 MB')
    // A press cancelled (a native drag) ends it too.
    menu.press(element)
    select(fact(element, 'Schema'))
    document.dispatchEvent(new Event('pointercancel'))
    expect(menu.target(element)?.text).toBe('Schema\tdbo')
  })
})
