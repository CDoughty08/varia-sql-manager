import type { Platform } from './keybindings'
import {
  gestureAvailable, gestureDefault, gestureDescriptor, gestureIds, gestureLabel, gestureScopes, physicalModifiers,
  type GestureChoice, type GestureId, type GestureScope, type PhysicalModifier
} from './gestures'

/**
 * Checks gesture choices before they are saved: a clash between two gestures that one press would start in the same
 * place is an error, and a modifier the desktop usually takes first is a warning (the user may still choose it). The
 * catalogue's defaults raise neither on any platform (`tests/gesture-validate.test.ts`), and no choice the Mouse view offers
 * today raises one either: the checks guard future catalogue choices and hand-edited files, and OK refuses a clash.
 */
export type GestureProblemCode = 'clash' | 'linuxAlt' | 'macControlClick'
export interface GestureProblem {
  readonly id: GestureId
  readonly severity: 'error' | 'warning'
  readonly code: GestureProblemCode
  /** Fixed wording built from the catalogue; never user text. */
  readonly message: string
  /** The gesture it clashes with. */
  readonly other?: GestureId
}

const scopesOf = (id: GestureId): readonly GestureScope[] => { const gesture = gestureDescriptor(id); return [gesture.scope, ...gesture.alsoIn ?? []] }
/** Global gestures work in every scope. */
function sharedScope(a: GestureId, b: GestureId): GestureScope | undefined {
  const left = scopesOf(a), right = scopesOf(b)
  if (left.includes('global')) return right[0]
  if (right.includes('global')) return left[0]
  return left.find(scope => right.includes(scope))
}
const within = (inner: readonly PhysicalModifier[], outer: readonly PhysicalModifier[]) => inner.every(modifier => outer.includes(modifier))
const pointerActions = new Set(['click', 'doubleClick', 'drag'])

/** The modifiers each gesture has on `platform` with `choices` applied (null where it is turned off or absent there). */
export function effectiveGestures(platform: Platform, choices: ReadonlyMap<GestureId, GestureChoice>): ReadonlyMap<GestureId, GestureChoice> {
  return new Map(gestureIds.map(id => [id, !gestureAvailable(id, platform) ? null : choices.has(id) ? choices.get(id)! : gestureDefault(id, platform)]))
}

/** Problems with `choices` (from `gestureOverrides`) on `platform`, for every gesture they touch, in catalogue order. */
export function validateGestures(platform: Platform, choices: ReadonlyMap<GestureId, GestureChoice>): readonly GestureProblem[] {
  const effective = effectiveGestures(platform, choices)
  const problems: GestureProblem[] = []
  const active = gestureIds.filter(id => effective.get(id))
  for (const id of active) {
    const gesture = gestureDescriptor(id), modifiers = effective.get(id)!, held = physicalModifiers(modifiers, platform)
    // Gestures match when all their modifiers are held, so a press that holds both sets starts both.
    for (const other of active) {
      if (other === id || gestureDescriptor(other).action !== gesture.action) continue
      const scope = sharedScope(id, other)
      if (!scope) continue
      const otherHeld = physicalModifiers(effective.get(other)!, platform)
      if (!within(held, otherHeld) && !within(otherHeld, held)) continue
      if (gesture.kind === 'fixed') continue
      const label = gestureLabel(gesture.action, effective.get(other)!, platform)
      problems.push({ id, other, severity: 'error', code: 'clash', message: `${label} already does ${gestureDescriptor(other).title} in ${gestureScopes[scope]}: one press would do both.` })
    }
    if (gesture.kind === 'fixed' || !pointerActions.has(gesture.action)) continue
    if (platform === 'linux' && held.includes('alt')) {
      problems.push({ id, severity: 'warning', code: 'linuxAlt', message: 'Many Linux desktops move the window on Alt+drag or Alt+click before Varia sees it. You can still choose it.' })
    }
    if (platform === 'darwin' && held.includes('ctrl') && gesture.action !== 'drag') {
      problems.push({ id, severity: 'warning', code: 'macControlClick', message: 'macOS treats Control+click as a right-click, so this gesture opens the context menu instead.' })
    }
  }
  return problems
}

/** Whether any problem blocks saving. */
export const gestureErrors = (problems: readonly GestureProblem[]): readonly GestureProblem[] => problems.filter(problem => problem.severity === 'error')
