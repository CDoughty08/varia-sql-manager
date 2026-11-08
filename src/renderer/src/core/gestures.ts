import {
  gestureAvailable, gestureDefault, gestureDescriptor, gestureLabel, gestureOptions, gestureOverrides, gesturePhrase, physicalModifiers, sameChoice,
  type GestureChoice, type GestureId, type GestureModifiers, type PhysicalModifier
} from '../../../shared/commands/gestures'
import type { Platform } from '../../../shared/commands/keybindings'
import { SnapshotStore } from './store'

/** The modifier fields of a pointer, mouse, wheel or drag event (or a test's plain object). */
export interface GestureEvent {
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
}
const fields: Readonly<Record<PhysicalModifier, keyof GestureEvent>> = { ctrl: 'ctrlKey', alt: 'altKey', shift: 'shiftKey', meta: 'metaKey' }
const keyNames: Readonly<Record<PhysicalModifier, readonly string[]>> = { ctrl: ['Control'], alt: ['Alt'], shift: ['Shift'], meta: ['Meta', 'OS'] }

/**
 * The one reader of pointer modifiers (`tests/gesture-lint.test.ts`): handlers ask whether an event is a catalogued
 * gesture (`src/shared/commands/gestures.ts`) instead of checking `ctrlKey` and the rest themselves. A gesture matches
 * when every one of its modifiers is held; other modifiers do not matter. One service per platform is shared by the
 * main window and its popouts, so a remap (through `setModifiers`) reaches every handler at once. Its snapshot is a
 * revision that changes with every remap: text that names a gesture (tab tooltips) subscribes to follow it.
 */
export class GestureService extends SnapshotStore<number> {
  private overrides = new Map<GestureId, GestureChoice>()
  constructor(readonly platform: Platform) { super(0) }

  /** The gesture's modifiers now, or null when it is turned off. */
  modifiers(id: GestureId): GestureModifiers | null {
    return this.overrides.has(id) ? this.overrides.get(id)! : gestureDefault(id, this.platform)
  }
  /**
   * Replaces the user's choices (null turns a modifier gesture off); ids left out return to their defaults. A locked
   * gesture, or a choice it does not offer on this platform, keeps its default. Takes the shortcuts file's `gestures`
   * as stored (`{ "dock.floatWhileDragging": "alt" }`) or choices already read.
   */
  setModifiers(choices: ReadonlyMap<GestureId, GestureChoice> | Readonly<Record<string, string>>): void {
    const read = choices instanceof Map ? choices as ReadonlyMap<GestureId, GestureChoice> : gestureOverrides(choices as Readonly<Record<string, string>>, this.platform)
    const next = new Map([...read].filter(([id, choice]) => gestureOptions(id, this.platform).some(option => sameChoice(option, choice))))
    const same = next.size === this.overrides.size && [...next].every(([id, choice]) => this.overrides.has(id) && sameChoice(this.overrides.get(id)!, choice))
    this.overrides = next
    if (!same) this.publish(this.getSnapshot() + 1)
  }

  /** Whether `event` holds the gesture's modifiers on this platform. */
  matches(id: GestureId, event: GestureEvent): boolean {
    const modifiers = this.modifiers(id)
    if (!modifiers || !gestureAvailable(id, this.platform)) return false
    return physicalModifiers(modifiers, this.platform).every(modifier => event[fields[modifier]] === true)
  }
  /** Whether a keydown or keyup's `key` is the gesture's (single) modifier, for gestures that follow it mid-drag. */
  isModifierKey(id: GestureId, key: string): boolean {
    const modifiers = this.modifiers(id)
    return !!modifiers && physicalModifiers(modifiers, this.platform).some(modifier => keyNames[modifier].includes(key))
  }
  /** `Ctrl+Double-click`, for tables and menus. */
  label(id: GestureId): string { const modifiers = this.modifiers(id); return modifiers ? gestureLabel(gestureDescriptor(id).action, modifiers, this.platform) : 'Off' }
  /** `Ctrl-double-click`, for tooltips and sentences. */
  phrase(id: GestureId): string { const modifiers = this.modifiers(id); return modifiers ? gesturePhrase(gestureDescriptor(id).action, modifiers, this.platform) : 'off' }
}

/**
 * A panel tab's tooltip, with the gestures' modifiers as they are now: `Drag to dock; Ctrl-drag to float; Ctrl-double-click
 * to toggle docking`. Float while dragging, turned off, drops out.
 */
export const paneTabTitle = (gestures: GestureService): string =>
  ['Drag to dock', gestures.modifiers('dock.floatWhileDragging') && `${gestures.phrase('dock.floatWhileDragging')} to float`, `${gestures.phrase('dock.toggleFloat')} to toggle docking`].filter(Boolean).join('; ')
/** A popout tab's tooltip, with Move Back into Main Window's gesture as it is now. */
export const popoutTabTitle = (gestures: GestureService): string => `Drag onto the main window to dock it there; ${gestures.phrase('popout.returnToMain')} to move it back`

const services = new Map<Platform, GestureService>()
/** The shared service for a platform; pure helpers that take a platform (grid selection, designer selectors) use it too. */
export function gesturesFor(platform: Platform): GestureService {
  let service = services.get(platform)
  if (!service) { service = new GestureService(platform); services.set(platform, service) }
  return service
}
