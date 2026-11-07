import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gestureDescriptor, gestureIds } from '../src/shared/commands/gestures'

const renderer = join('src', 'renderer', 'src')
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])
const name = (file: string) => relative(renderer, file).replaceAll('\\', '/')

/** The renderer modules allowed to read pointer modifiers themselves, and why. */
const allowed: Readonly<Record<string, string>> = {
  'core/gestures.ts': 'GestureService, the one reader',
  'plans/PlanCanvas.ts': 'the plan canvas\'s Ctrl/⌘+wheel zoom and Shift+wheel pan, a fixed widget in the manner of map viewers'
}

const modifierRead = /\.(ctrlKey|metaKey|altKey|shiftKey)\b/g
// A line that opens a function's block: an arrow, a function, or a method or class-field signature (not an if or a loop).
const functionStart = /^(?!\s*(?:\}\s*)?(?:if|else|for|while|switch|catch|try)\b).*(?:=>|\))\s*(?::[^{=]+)?\{\s*$/
const keyboardSignal = /\bKeyboardEvent\b|\bKeyEventLike\b|\bonKey(?:Down|Up)\b|['"`]key(?:down|up)['"`]|\bevent\.key\b/
const pointerSignal = /\b(?:Pointer|Mouse|Wheel|Drag)Event\b|\bon(?:Pointer|Mouse|Click|DoubleClick|Wheel|Drag|Drop|ContextMenu)\w*=|['"`](?:pointer\w*|mouse\w*|wheel|click|dblclick|drag\w*|drop|contextmenu)['"`]|\bnativeEvent\.(?:ctrl|meta|alt|shift)Key\b|\bbutton\s*:\s*number\b|\bevent\.button\b|\bPositionResolverArgs\b|\bargs\.event\b|\bonWill(?:ShowOverlay|Drop|DragPanel|DragGroup)\b/

/**
 * Modifier reads that sit in a pointer, mouse, wheel or drag handler: from the read back to the line that starts its
 * function, the text names a pointer event (a type, a JSX handler, a listener's event name, a `button` field) and no key
 * event. A heuristic over source text, since the TypeScript package carries no compiler API.
 */
export function pointerModifierReads(source: string): { readonly line: number; readonly text: string }[] {
  const lines = source.split('\n'), found: { line: number; text: string }[] = []
  lines.forEach((text, index) => {
    for (const match of text.matchAll(modifierRead)) {
      // An inline handler (`onDoubleClick={event => ...}`) is its own context; otherwise walk back to the enclosing function.
      const prefix = text.slice(0, match.index)
      let start = index
      if (!/=>|\bfunction\b/.test(prefix)) while (start > 0 && !functionStart.test(lines[start]) && index - start < 40) start--
      const context = [...lines.slice(start, index), prefix].join('\n')
      if (pointerSignal.test(context) && !keyboardSignal.test(context)) found.push({ line: index + 1, text: text.trim() })
    }
  })
  return found
}

describe('gesture lint', () => {
  it('reads pointer modifiers only through GestureService', () => {
    const offenders = files(renderer).filter(file => !Object.hasOwn(allowed, name(file)))
      .flatMap(file => pointerModifierReads(readFileSync(file, 'utf8')).map(read => `${name(file)}:${read.line}: ${read.text}`))
    expect(offenders).toEqual([])
    for (const file of Object.keys(allowed)) expect(readFileSync(join(renderer, file), 'utf8'), file).toMatch(/\b(?:ctrlKey|metaKey|altKey|shiftKey)\b/)
  })
  it('catches the raw checks the catalogue replaced', () => {
    // The handlers as they were before GestureService.
    const before = [
      "    onDoubleClick={event => { if (event.ctrlKey && !(event.target as HTMLElement).closest('button')) commands.toggle(props.api.id as PaneId) }} /></div>",
      "  private move = (event: PointerEvent) => {\n    if (!this.source) return\n    this.point = { x: event.clientX, y: event.clientY, ctrl: event.ctrlKey }\n  }",
      "      api.onWillShowOverlay(event => { if (event.nativeEvent.ctrlKey || this.point.ctrl) event.preventDefault() }),",
      "  resolve(args: PositionResolverArgs) {\n    if (!this.source || this.movingFloat || args.event.ctrlKey || this.point.ctrl) return null\n  }",
      "  private pointerDown(event: PointerEvent): void {\n    const press = pressButton(event, this.o.platform)\n    const add = press === 'primary' && (this.o.platform === 'darwin' ? event.metaKey : event.ctrlKey)\n  }",
      "export function pressButton(event: { readonly button: number; readonly ctrlKey: boolean }, platform: Platform): 'primary' | 'secondary' | undefined {\n  if (event.button === 2 || (event.button === 0 && event.ctrlKey && platform === 'darwin')) return 'secondary'\n}",
      "  const key = (event: KeyboardEvent<HTMLDivElement>) => {\n  }\n  return <div onKeyDown={key}\n    onDoubleClick={event => { if (event.ctrlKey && !(event.target as Element).closest('button')) commands.moveToMain(pane) }}>",
      "  const scrollPinnedBand = useCallback((event: WheelEvent) => {\n    if (!tree || event.ctrlKey || !event.deltaY) return\n  }, [])"
    ]
    for (const source of before) expect(pointerModifierReads(source), source).not.toEqual([])
    // Key handlers keep their own modifier checks: chords are the keybinding service's business.
    const keys = [
      "  const key = (event: KeyboardEvent<HTMLDivElement>) => {\n    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return\n  }",
      "    onKeyDown={event => { if (event.shiftKey && event.key === 'Tab') last.focus() }}"
    ]
    for (const source of keys) expect(pointerModifierReads(source), source).toEqual([])
  })
  it('wires every gesture that reads a modifier or runs a command to a handler', () => {
    const sources = files(renderer).map(file => readFileSync(file, 'utf8')).join('\n')
    for (const id of gestureIds) {
      const gesture = gestureDescriptor(id)
      if (gesture.kind === 'fixed' && !gesture.modifiers.length) continue
      expect(sources, id).toMatch(new RegExp(`\\.matches\\('${id.replace('.', '\\.')}'`))
    }
  })
})
