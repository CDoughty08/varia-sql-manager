import type { Platform } from '../../../shared/commands/keybindings'
import type { VariaApi } from '../../../shared/contracts'
import {
  clampVitalsWidth, defaultInspectorVitals, defaultInspectorVitalsPrefs,
  type InspectorSurface, type InspectorVitalsPrefs, type VitalsSurfacePrefs
} from '../../../shared/inspector-vitals'
import { onUnexpectedError } from '../core/errors'
import { SnapshotStore } from '../core/store'
import type { Disposable, ExternalStore } from '../core/types'
import { windows } from '../core/windows'

export type InspectorTabTarget = number | 'last'
export type InspectorTabHandler = (target: InspectorTabTarget) => boolean

interface RegisteredInspector {
  readonly element: HTMLElement
  readonly goToTab: InspectorTabHandler
}

export interface InspectorServiceOptions {
  readonly api?: Partial<Pick<VariaApi, 'loadInspectorVitals' | 'saveInspectorVitals'>>
  readonly platform?: Platform
  readonly activeElement?: () => Element | null
  readonly report?: (message: string, kind: 'warning' | 'error') => void
}

class ValueStore<T> extends SnapshotStore<T> {
  set(next: T): void { this.publish(next) }
  dispose(): void { this.clearListeners() }
}

/**
 * Shared state for unified object inspectors (`ObjectInspectorFrame`):
 * - Independent `full` and `peek` Vitals rail preferences persisted atomically through main.
 * - Modifier-hold state fed from `KeybindingService` (`Ctrl` on Windows/Linux, `⌘` on macOS) so Full-surface tabs reveal
 *   subtle `1`–`9` shortcut badges while held, without adding a second key listener.
 * - Focus-aware registry of mounted inspector frames for `inspector.goToTab1..8` and `inspector.goToLastTab`.
 */
export class InspectorService implements Disposable {
  private readonly vitalsStore = new ValueStore<InspectorVitalsPrefs>(defaultInspectorVitalsPrefs())
  private readonly modHeldStore = new ValueStore<boolean>(false)
  private readonly frames = new Set<RegisteredInspector>()
  private readonly dirty = new Set<InspectorSurface>()
  private loading = false
  private report?: (message: string, kind: 'warning' | 'error') => void
  private pendingReport?: { readonly message: string; readonly kind: 'warning' | 'error' }
  private disposed = false

  readonly vitals: ExternalStore<InspectorVitalsPrefs> = this.vitalsStore
  readonly modHeld: ExternalStore<boolean> = this.modHeldStore

  constructor(private readonly options: InspectorServiceOptions = {}) {
    this.report = options.report
  }

  private notify(message: string, kind: 'warning' | 'error'): void {
    if (this.report) this.report(message, kind)
    else this.pendingReport = { message, kind }
  }

  setReporter(report: (message: string, kind: 'warning' | 'error') => void): void {
    this.report = report
    if (this.pendingReport) {
      const pending = this.pendingReport
      this.pendingReport = undefined
      report(pending.message, pending.kind)
    }
  }

  private persist(prefs: InspectorVitalsPrefs): void {
    if (!this.options.api?.saveInspectorVitals) return
    void this.options.api.saveInspectorVitals(prefs).then(result => {
      if (!this.disposed && !result.ok) this.notify(result.error, 'error')
    }, error => { if (!this.disposed) onUnexpectedError(error) })
  }

  async load(): Promise<void> {
    if (!this.options.api?.loadInspectorVitals) return
    this.loading = true
    try {
      const result = await this.options.api.loadInspectorVitals()
      if (this.disposed) return
      if (!result.ok) {
        this.notify(result.error, 'error')
        return
      }
      const { prefs, warning } = result.value
      const current = this.vitalsStore.getSnapshot()
      const next: InspectorVitalsPrefs = {
        full: this.dirty.has('full') ? current.full : { open: prefs.full.open, width: clampVitalsWidth(prefs.full.width, 'full') },
        peek: this.dirty.has('peek') ? current.peek : { open: prefs.peek.open, width: clampVitalsWidth(prefs.peek.width, 'peek') }
      }
      if (next.full.open !== current.full.open || next.full.width !== current.full.width || next.peek.open !== current.peek.open || next.peek.width !== current.peek.width) {
        this.vitalsStore.set(next)
      }
      if (warning) this.notify(warning, 'warning')
      // Persist any local mutation deferred while the initial load was in flight, merged with the loaded surface.
      if (this.dirty.size > 0) this.persist(next)
    } catch (error) {
      if (!this.disposed) onUnexpectedError(error)
    } finally {
      this.loading = false
    }
  }

  setVitals(surface: InspectorSurface, patch: Partial<VitalsSurfacePrefs>, containerWidth?: number): void {
    if (this.disposed) return
    const current = this.vitalsStore.getSnapshot()
    const prev = current[surface]
    const open = patch.open ?? prev.open
    const width = patch.width !== undefined ? clampVitalsWidth(patch.width, surface, containerWidth) : prev.width
    if (open === prev.open && width === prev.width) return
    this.dirty.add(surface)
    const next: InspectorVitalsPrefs = { ...current, [surface]: { open, width } }
    this.vitalsStore.set(next)
    // Defer writes while initial load is in flight so an unloaded surface's default never clobbers disk.
    if (!this.loading) this.persist(next)
  }

  toggleVitals(surface: InspectorSurface): void {
    const current = this.vitalsStore.getSnapshot()[surface]
    this.setVitals(surface, { open: !current.open })
  }

  resetVitalsWidth(surface: InspectorSurface, containerWidth?: number): void {
    this.setVitals(surface, { width: defaultInspectorVitals[surface].width }, containerWidth)
  }

  registerFrame(element: HTMLElement, goToTab: InspectorTabHandler): Disposable {
    const entry: RegisteredInspector = { element, goToTab }
    this.frames.add(entry)
    return { dispose: () => { this.frames.delete(entry) } }
  }

  private focusedFrame(): RegisteredInspector | undefined {
    const active = this.options.activeElement ? this.options.activeElement() : typeof document === 'undefined' ? null : windows.activeElement()
    if (!active) return undefined
    let best: RegisteredInspector | undefined
    for (const frame of this.frames) {
      if (!frame.element.contains(active)) continue
      // When an inspector is nested inside another, prefer the innermost frame containing focus.
      if (!best || best.element.contains(frame.element)) best = frame
    }
    return best
  }

  hasFocusedFrame(): boolean { return this.focusedFrame() !== undefined }

  goToTab(target: InspectorTabTarget): boolean {
    return this.focusedFrame()?.goToTab(target) ?? false
  }

  private isModKey(key: string): boolean {
    return this.options.platform === 'darwin' ? key === 'Meta' : key === 'Control'
  }

  keyDown(key: string, repeat: boolean): void {
    if (this.disposed || repeat || !this.isModKey(key)) return
    if (!this.modHeldStore.getSnapshot()) this.modHeldStore.set(true)
  }

  keyUp(key: string): void {
    if (this.disposed || !this.isModKey(key)) return
    if (this.modHeldStore.getSnapshot()) this.modHeldStore.set(false)
  }

  blur(): void {
    if (this.disposed) return
    if (this.modHeldStore.getSnapshot()) this.modHeldStore.set(false)
  }

  dispose(): void {
    this.disposed = true
    this.frames.clear()
    this.modHeldStore.set(false)
    this.modHeldStore.dispose()
    this.vitalsStore.dispose()
  }
}
