/**
 * Just enough of the DOM for menu targets in Node: a tree of elements with classes and attributes, `closest`,
 * `matches`, and `querySelector` over simple selectors (tags, classes, attributes, and `:not([…])`, comma-separated),
 * focus, rects, and the text-field properties `inputTarget` reads.
 */
/** The document's selection: its text, and the element it starts and ends in (`selectionIn`), if any. */
export interface FakeDocument {
  activeElement: FakeElement | null
  selection: string
  selectionIn: FakeElement | null
  getSelection(): { toString(): string; readonly anchorNode: FakeElement | null; readonly focusNode: FakeElement | null; selectAllChildren(element: FakeElement): void }
}
export function fakeDocument(): FakeDocument {
  const document: FakeDocument = {
    activeElement: null, selection: '', selectionIn: null,
    getSelection: () => ({
      toString: () => document.selection, anchorNode: document.selectionIn, focusNode: document.selectionIn,
      selectAllChildren: element => { document.selection = element.textContent; document.selectionIn = element }
    })
  }
  return document
}

type Rect = { left: number; top: number; right: number; bottom: number }
const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/
function matchesCompound(element: FakeElement, compound: string): boolean {
  const parts = compound.match(/^[a-z]+|\.[\w-]+|:not\(\[[^\]]+\]\)|\[[^\]]+\]/gi) ?? []
  if (parts.join('') !== compound) throw new Error(`Unsupported selector: ${compound}`)
  return parts.every(part => {
    if (part.startsWith('.')) return element.classes.has(part.slice(1))
    if (part.startsWith(':not(')) return !matchesCompound(element, part.slice(5, -1))
    const match = attribute.exec(part)
    if (match) return element.attributes.has(match[1]) && (match[2] === undefined || element.attributes.get(match[1]) === match[2])
    return element.tagName === part.toUpperCase()
  })
}

export class FakeElement {
  readonly tagName: string
  readonly classes: Set<string>
  readonly attributes = new Map<string, string>()
  parentElement: FakeElement | null = null
  readonly children: FakeElement[] = []
  rect: Rect = { left: 0, top: 0, right: 100, bottom: 20 }
  focusCalls = 0
  type?: string
  value?: string
  readOnly?: boolean
  disabled?: boolean
  selectionStart?: number | null
  selectionEnd?: number | null
  isContentEditable = false
  isConnected = true
  textContent = ''
  constructor(readonly ownerDocument: FakeDocument, tag: string, init: { className?: string; attributes?: Record<string, string> } & Partial<Pick<FakeElement, 'type' | 'value' | 'readOnly' | 'disabled' | 'selectionStart' | 'selectionEnd' | 'isContentEditable' | 'textContent'>> = {}) {
    const { className, attributes, ...properties } = init
    this.tagName = tag.toUpperCase()
    this.classes = new Set(className?.split(' ').filter(Boolean))
    for (const [name, value] of Object.entries(attributes ?? {})) this.attributes.set(name, value)
    Object.assign(this, properties)
  }
  append(...children: FakeElement[]): this {
    for (const child of children) { child.parentElement = this; this.children.push(child) }
    return this
  }
  matches(selector: string): boolean { return selector.split(',').some(compound => matchesCompound(this, compound.trim())) }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  contains(other: FakeElement | null): boolean {
    for (let node = other; node; node = node.parentElement) if (node === this) return true
    return false
  }
  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found }
    return null
  }
  get dataset(): Record<string, string> {
    return Object.fromEntries([...this.attributes].flatMap(([name, value]) => name.startsWith('data-') ? [[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]] : []))
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  getBoundingClientRect(): Rect { return this.rect }
  focus(): void { this.focusCalls++; this.ownerDocument.activeElement = this }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null }
  /** As the element type the code under test expects. */
  get dom(): HTMLElement { return this as unknown as HTMLElement }
}
