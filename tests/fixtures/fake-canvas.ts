// A 2D canvas context, canvas and chart environment for ChartView in Node: the context records what a draw does (styles,
// paths and their vertices, text, dashes) without drawing, so tests and the chart benchmark can count it.
import type { ChartEnvironment } from '../../src/renderer/src/live/ChartView'

export interface Stroke { readonly style: string; readonly vertices: number; readonly moves: number; readonly dash: readonly number[]; readonly width: number; readonly points: readonly (readonly [number, number])[] }
export interface Fill { readonly style: string; readonly alpha: number; readonly vertices: number }

/** Records paths: each stroke or fill keeps the path's vertices (moveTo and lineTo calls) and the style it used. */
export class FakeContext {
  readonly styles: string[] = []
  readonly strokes: Stroke[] = []
  readonly fills: Fill[] = []
  readonly texts: { text: string; x: number; y: number; style: string; align: string }[] = []
  readonly arcs: { x: number; y: number; radius: number }[] = []
  calls = 0
  font = ''
  textAlign = 'start'
  textBaseline = 'alphabetic'
  lineWidth = 1
  lineJoin = 'miter'
  globalAlpha = 1
  private fillValue = ''
  private strokeValue = ''
  private count = 0
  private dash: number[] = []
  private path: [number, number][] = []
  private moves = 0
  /** Points are recorded only while this is on; counting alone is what the benchmark measures. */
  constructor(readonly keepPoints = true) {}
  get fillStyle(): string { return this.fillValue }
  set fillStyle(value: string) { this.fillValue = value; this.styles.push(value) }
  get strokeStyle(): string { return this.strokeValue }
  set strokeStyle(value: string) { this.strokeValue = value; this.styles.push(value) }
  setTransform(): void { this.calls++ }
  clearRect(): void { this.calls++ }
  setLineDash(dash: number[]): void { this.calls++; this.dash = [...dash] }
  beginPath(): void { this.calls++; this.path = []; this.moves = 0; this.count = 0 }
  moveTo(x: number, y: number): void { this.calls++; this.count++; this.moves++; if (this.keepPoints) this.path.push([x, y]) }
  lineTo(x: number, y: number): void { this.calls++; this.count++; if (this.keepPoints) this.path.push([x, y]) }
  closePath(): void { this.calls++ }
  arc(x: number, y: number, radius: number): void { this.calls++; this.arcs.push({ x, y, radius }) }
  stroke(): void { this.calls++; this.strokes.push({ style: this.strokeValue, vertices: this.count, moves: this.moves, dash: this.dash, width: this.lineWidth, points: this.path }) }
  measureText(text: string): { width: number } { return { width: text.length * 6 } }
  fillText(text: string, x: number, y: number): void { this.calls++; this.texts.push({ text, x, y, style: this.fillValue, align: this.textAlign }) }
  fill(): void { this.calls++; this.fills.push({ style: this.fillValue, alpha: this.globalAlpha, vertices: this.count }) }
  reset(): void { this.styles.length = 0; this.strokes.length = 0; this.fills.length = 0; this.texts.length = 0; this.arcs.length = 0; this.calls = 0 }
}

class FakeNode {
  nodeValue: string | null = ''
}
export class FakeElement {
  className = ''
  hidden = false
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly children: (FakeElement | FakeNode)[] = []
  parent?: FakeElement
  offsetWidth = 80
  offsetHeight = 18
  offsetTop = 0
  offsetLeft = 0
  constructor(readonly ownerDocument: FakeOwner, readonly tagName: string) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  append(...children: (FakeElement | FakeNode)[]): void { for (const child of children) { if (child instanceof FakeElement) child.parent = this; this.children.push(child) } }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  /** The text of its Text nodes. */
  get text(): string { return this.children.map(child => child instanceof FakeNode ? child.nodeValue ?? '' : child.text).join('') }
}
export interface FakeOwner { createElement(tag: string): FakeElement; createTextNode(text: string): FakeNode }
export function fakeOwner(): FakeOwner {
  const owner: FakeOwner = { createElement: tag => new FakeElement(owner, tag), createTextNode: text => { const node = new FakeNode(); node.nodeValue = text; return node } }
  return owner
}

export class FakeCanvas extends FakeElement {
  width = 300
  height = 150
  clientWidth: number
  clientHeight: number
  readonly context: FakeContext
  readonly listeners = new Map<string, (event: unknown) => void>()
  constructor(owner: FakeOwner, width: number, height: number, context = new FakeContext()) {
    super(owner, 'canvas')
    this.clientWidth = width
    this.clientHeight = height
    this.context = context
  }
  getContext(): FakeContext { return this.context }
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener) }
  removeEventListener(type: string): void { this.listeners.delete(type) }
  getBoundingClientRect(): { left: number; top: number } { return { left: 0, top: 0 } }
}

/** Frames run when the test says; visibility, size and forced colors change when it says. */
export class FakeChartEnvironment implements ChartEnvironment {
  frames: (() => void)[] = []
  requested = 0
  time = 1_000_000
  forced = false
  ratio = 1
  timers: { at: number; callback: () => void; id: number }[] = []
  visibility?: (visible: boolean) => void
  size?: () => void
  forcedListener?: () => void
  requestFrame(callback: () => void): number { this.requested++; this.frames.push(callback); return this.frames.length }
  cancelFrame(): void { this.frames = [] }
  observeVisibility(_element: Element, listener: (visible: boolean) => void): () => void { this.visibility = listener; return () => { this.visibility = undefined } }
  observeSize(_element: Element, listener: () => void): () => void { this.size = listener; return () => { this.size = undefined } }
  forcedColors(): boolean { return this.forced }
  observeForcedColors(listener: () => void): () => void { this.forcedListener = listener; return () => { this.forcedListener = undefined } }
  devicePixelRatio(): number { return this.ratio }
  now(): number { return this.time }
  setTimeout(callback: () => void, ms: number): unknown { const id = this.timers.length + 1; this.timers.push({ at: this.time + ms, callback, id }); return id }
  clearTimeout(handle: unknown): void { this.timers = this.timers.filter(timer => timer.id !== handle) }
  /** Runs the frames requested so far. */
  flush(): number {
    const frames = this.frames
    this.frames = []
    for (const frame of frames) frame()
    return frames.length
  }
  advance(ms: number): void {
    this.time += ms
    const due = this.timers.filter(timer => timer.at <= this.time)
    this.timers = this.timers.filter(timer => timer.at > this.time)
    for (const timer of due) timer.callback()
  }
}
