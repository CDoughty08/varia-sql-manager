import { platforms, type Platform } from './keybindings'
import {
  gestureDefault, gestureIds, gestureModifiers, gestureOptions, isGestureId, sameChoice, type GestureChoice, type GestureId, type GestureModifier, type GestureModifiers
} from './gestures'

/**
 * How a gesture choice is written in `shortcuts.json`'s `gestures` map: `off` turns a modifier gesture off, `none` is no
 * modifier, and modifier sets are their names in catalogue order run together in camel case (`mod`, `alt`, `modShift`),
 * which the schema's choice pattern (`[a-z][A-Za-z0-9]*`) allows. Texts are platform-neutral: `mod` is Ctrl or ⌘ wherever
 * the file is read, and the file keeps only changes from the platform's default.
 */
export const gestureOff = 'off'
export const gestureNone = 'none'

const ordered = (modifiers: GestureModifiers): GestureModifier[] => gestureModifiers.filter(modifier => modifiers.includes(modifier))
export function gestureChoiceText(modifiers: GestureChoice): string {
  if (modifiers === null) return gestureOff
  const names = ordered(modifiers)
  return names.length ? names.map((name, index) => index ? name[0].toUpperCase() + name.slice(1) : name).join('') : gestureNone
}
/** The modifiers a choice names, null for `off`, or undefined when the text names no modifier set. */
export function gestureChoiceFromText(text: string): GestureChoice | undefined {
  if (text === gestureOff) return null
  if (text === gestureNone) return []
  const names = text.split(/(?=[A-Z])/).map(part => part.toLowerCase())
  if (!names.every((name): name is GestureModifier => (gestureModifiers as readonly string[]).includes(name))) return undefined
  const modifiers = ordered(names)
  return modifiers.length === names.length && gestureChoiceText(modifiers) === text ? modifiers : undefined
}
/**
 * Every gesture's choices as text on any platform, default first (with macOS's own choices, and `off` where a modifier
 * gesture may be turned off), for `readShortcutFile`.
 */
export const gestureChoiceTexts: ReadonlyMap<string, readonly string[]> = new Map(gestureIds.flatMap(id => {
  const texts = [...new Set(platforms.flatMap(platform => gestureOptions(id, platform).map(gestureChoiceText)))]
  return texts.length ? [[id, texts] as const] : []
}))
/**
 * A file's `gestures` map as `GestureService.setModifiers` takes it. Ids this build does not know, locked gestures and
 * texts that name no offered choice (on `platform`, when given) are left out, so those gestures keep their defaults.
 */
export function gestureOverrides(gestures: Readonly<Record<string, string>>, platform?: Platform): Map<GestureId, GestureChoice> {
  const overrides = new Map<GestureId, GestureChoice>()
  for (const [id, text] of Object.entries(gestures)) {
    if (!isGestureId(id) || !gestureChoiceTexts.get(id)?.includes(text)) continue
    const choice = gestureChoiceFromText(text)
    if (choice === undefined) continue
    if (platform && !gestureOptions(id, platform).some(option => sameChoice(option, choice))) continue
    overrides.set(id, choice)
  }
  return overrides
}
/**
 * The file's gestures with `id` set to `choice`, or back to its default when `choice` is undefined or is the platform's
 * default (the file keeps only changes). Other entries, including ones this build does not know, are kept.
 */
export function withGestureChoice(gestures: Readonly<Record<string, string>>, id: GestureId, choice: GestureChoice | undefined, platform: Platform): Record<string, string> {
  const next: Record<string, string> = { ...gestures }
  delete next[id]
  if (choice !== undefined && !sameChoice(choice, gestureDefault(id, platform))) next[id] = gestureChoiceText(choice)
  return next
}
