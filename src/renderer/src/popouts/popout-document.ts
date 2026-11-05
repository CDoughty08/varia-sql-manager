/**
 * A popout window's document as the workbench uses it: the main document's style sheets and root attributes (the theme's
 * `--varia-*` variables, color scheme, density and theme type live there) copied in and kept in sync, and an empty root to
 * render the window's frame into. The popout is a same-origin `about:blank` child, so it inherits the page's CSP and the
 * copied `<link>`s and `<style>`s load under it as they do in the main document.
 */
export interface PopoutDocument {
  readonly root: HTMLElement
  setTitle(title: string): void
  dispose(): void
}

/** Root attributes the popout keeps for itself: its own window's focus. */
const ownAttributes: ReadonlySet<string> = new Set(['data-window-focus'])
const styleSelector = 'style, link[rel="stylesheet"]'

export function preparePopoutDocument(child: Window, main: Document, title: string): PopoutDocument {
  const doc = child.document
  const head = doc.head ?? doc.documentElement.appendChild(doc.createElement('head'))
  const body = doc.body ?? doc.documentElement.appendChild(doc.createElement('body'))
  if (!doc.querySelector('meta[charset]')) { const meta = doc.createElement('meta'); meta.setAttribute('charset', 'UTF-8'); head.prepend(meta) }
  doc.title = title
  const clones = new Map<Element, Element>()
  // Sheets in the main document's order; a dev-server sheet replaced by hot reload is replaced here too.
  const syncStyles = () => {
    const sources = [...main.head.querySelectorAll(styleSelector)]
    for (const [source, clone] of clones) if (!source.isConnected) { clone.remove(); clones.delete(source) }
    const wanted = sources.map(source => {
      let clone = clones.get(source)
      if (!clone) { clone = doc.importNode(source, true); clones.set(source, clone) }
      else if (source.tagName === 'STYLE' && clone.textContent !== source.textContent) clone.textContent = source.textContent
      else if (source.tagName === 'LINK' && clone.getAttribute('href') !== source.getAttribute('href')) clone.setAttribute('href', source.getAttribute('href') ?? '')
      return clone
    })
    // Moved only when the order differs: re-inserting a sheet re-applies it, and the main head changes for many reasons
    // (its title changes with the active query) that leave the sheets as they were.
    const placed = [...head.children].filter(element => wanted.includes(element))
    if (placed.length !== wanted.length || placed.some((element, index) => element !== wanted[index])) for (const clone of wanted) head.append(clone)
  }
  const syncRoot = () => {
    const from = main.documentElement, to = doc.documentElement
    for (const attribute of [...to.attributes]) if (!ownAttributes.has(attribute.name) && !from.hasAttribute(attribute.name)) to.removeAttribute(attribute.name)
    for (const attribute of [...from.attributes]) if (!ownAttributes.has(attribute.name) && to.getAttribute(attribute.name) !== attribute.value) to.setAttribute(attribute.name, attribute.value)
  }
  syncStyles()
  syncRoot()
  body.className = 'popout-body'
  const root = doc.createElement('div')
  root.className = 'popout-root'
  body.replaceChildren(root)
  const styles = new MutationObserver(syncStyles), attributes = new MutationObserver(syncRoot)
  styles.observe(main.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href'] })
  attributes.observe(main.documentElement, { attributes: true })
  return {
    root,
    setTitle: value => { if (!child.closed) doc.title = value },
    dispose: () => { styles.disconnect(); attributes.disconnect() }
  }
}
