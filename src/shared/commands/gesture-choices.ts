import { gestureDescriptor, gestureIds, gestureModifiers, isGestureId, type GestureId, type GestureModifier, type GestureModifiers } from './gestures'

/**
 * How a gesture choice is written in `shortcuts.json`'s `gestures` map: `off` turns a modifier gesture off, `none` is no
 * modifier, and modifier sets are their names in catalogue order run together in camel case (`mod`, `alt`, `modShift`),
 * which the schema's choice pattern (`[a-z][A-Za-z0-9]*`) allows.
 */
export const gestureOff = 'off'
export const gestureNone = 'none'

const ordered = (modifiers: GestureModifiers): GestureModifier[] => gestureModifiers.filter(modifier => modifiers.includes(modifier))
export function gestureChoiceText(modifiers: GestureModifiers | null): string {
  if (modifiers === null) return gestureOff
  const names = ordered(modifiers)
  return names.length ? names.map((name, index) => index ? name[0].toUpperCase() + name.slice(1) : name).join('') : gestureNone
}
/** The modifiers a choice names, null for `off`, or undefined when the text names no modifier set. */
export function gestureChoiceFromText(text: string): GestureModifiers | null | undefined {
  if (text === gestureOff) return null
  if (text === gestureNone) return []
  const names = text.split(/(?=[A-Z])/).map(part => part.toLowerCase())
  if (!names.every((name): name is GestureModifier => (gestureModifiers as readonly string[]).includes(name))) return undefined
  const modifiers = ordered(names)
  return modifiers.length === names.length && gestureChoiceText(modifiers) === text ? modifiers : undefined
}
/** Every gesture's choices as text, default first (and `off` where a modifier gesture may be turned off), for `readShortcutFile`. */
export const gestureChoiceTexts: ReadonlyMap<string, readonly string[]> = new Map(gestureIds.flatMap(id => {
  const gesture = gestureDescriptor(id)
  return gesture.choices ? [[id, [...gesture.choices.map(gestureChoiceText), ...gesture.kind === 'modifier' ? [gestureOff] : []]]] : []
}))
/**
 * A file's `gestures` map as `GestureService.setModifiers` takes it. Ids this build does not know, locked gestures and
 * texts that name no offered choice are left out, so those gestures keep their defaults.
 */
export function gestureOverrides(gestures: Readonly<Record<string, string>>): Map<GestureId, GestureModifiers | null> {
  const overrides = new Map<GestureId, GestureModifiers | null>()
  for (const [id, text] of Object.entries(gestures)) {
    if (!isGestureId(id) || !gestureChoiceTexts.get(id)?.includes(text)) continue
    const modifiers = gestureChoiceFromText(text)
    if (modifiers !== undefined) overrides.set(id, modifiers)
  }
  return overrides
}
